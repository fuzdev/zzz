/**
 * Cross-backend integration tests for `workspace_*` actions.
 *
 * Ported from `test/integration/tests.ts` (Deno standalone runner) into
 * vitest's cross-backend layout. Each test mints a fresh per-test
 * account via `default_cross_process_setup` and drives RPC + WS frames
 * against the spawned test binary specified by the `backend_handle`
 * injected from `globalSetup`.
 *
 * @module
 */

import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {describe, test, inject, assert} from 'vitest';
import {
	default_cross_process_setup,
	type BootstrappedBackendHandle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {rpc_call} from '@fuzdev/fuz_app/testing/rpc_helpers.js';
import {create_ws_transport} from '@fuzdev/fuz_app/testing/transports/ws_transport.js';
import {is_notification} from '@fuzdev/fuz_app/testing/transports/ws_client.js';
import type {FetchTransport} from '@fuzdev/fuz_app/testing/transports/fetch_transport.js';
import type {RpcTestTransport} from '@fuzdev/fuz_app/testing/rpc_helpers.js';

declare module 'vitest' {
	export interface ProvidedContext {
		backend_handle: BootstrappedBackendHandle;
	}
}

const handle = inject('backend_handle');
const setup_test = default_cross_process_setup(handle);

// Local adapters working around two type seams in fuz_app's cross-process
// testing surface that didn't land in Session 2:
//
// 1. `TestFixtureBase.transport` is typed `RpcTestTransport` (a bare
//    callable) but the cross-process runtime returns a `FetchTransport`
//    (callable + `.cookies()`). The narrow shape forces a cast here.
// 2. `rpc_call` takes `app: {request: (input, init) => Response}` but
//    `RpcTestTransport` is the bare callable `(input, init) => Response`.
//    No structural overlap, so wrap.
//
// Both seams should fold back into fuz_app — widen `TestFixtureBase.transport`
// to a union including `FetchTransport`, and accept either shape on
// `rpc_call.app`. Tracked in `grimoire/lore/fuz_app/TODO_CROSS_PROCESS_LIFT.md`
// §Session 3d follow-ups.
const fetch_transport = (t: RpcTestTransport): FetchTransport => t as unknown as FetchTransport;
const as_rpc_app = (t: RpcTestTransport) => ({
	request: (input: string, init: RequestInit) => t(input, init),
});

/** Create a fresh tmp directory for a workspace; caller cleans up. */
const create_tmp_workspace = async (label: string): Promise<string> => {
	const dir = join(tmpdir(), `zzz_cross_ws_${label}_${randomUUID()}`);
	await mkdir(dir, {recursive: true});
	return dir;
};

const remove_dir = async (path: string): Promise<void> => {
	await rm(path, {recursive: true, force: true});
};

describe('workspace cross-backend', () => {
	test('workspace_open_and_list', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('open_list');
		try {
			const open = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(open.ok, `workspace_open failed: ${JSON.stringify(open)}`);
			const open_result = open.result as Record<string, unknown>;
			const workspace = open_result.workspace as Record<string, unknown>;
			assert.equal(typeof workspace.path, 'string');
			assert.ok((workspace.path as string).endsWith('/'), 'path ends with /');
			assert.equal(typeof workspace.name, 'string');
			assert.equal(typeof workspace.opened_at, 'string');
			assert.ok(Array.isArray(open_result.files), 'files is array');

			const list = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_list',
				headers: fixture.create_session_headers(),
			});
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
				Record<string, unknown>
			>;
			assert.ok(workspaces.some((w) => w.path === workspace.path), 'opened workspace in list');
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_idempotent', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('idempotent');
		try {
			const r1 = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(r1.ok);
			const w1 = (r1.result as Record<string, unknown>).workspace as Record<string, unknown>;

			const r2 = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(r2.ok);
			const w2 = (r2.result as Record<string, unknown>).workspace as Record<string, unknown>;

			assert.equal(w1.opened_at, w2.opened_at, 'same opened_at');
			assert.equal(w1.path, w2.path, 'same path');
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_nonexistent', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: as_rpc_app(fixture.transport),
			path: handle.config.rpc_path,
			method: 'workspace_open',
			params: {path: `/tmp/zzz_nonexistent_${randomUUID()}`},
			headers: fixture.create_session_headers(),
		});
		assert.ok(!res.ok, 'expected error');
		assert.equal(res.error.code, -32603);
		assert.ok(
			res.error.message.startsWith('failed to open workspace: directory does not exist:'),
			`unexpected message: ${res.error.message}`,
		);
	});

	test('workspace_close', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('close');
		try {
			const open = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(open.ok);
			const workspace = (open.result as Record<string, unknown>).workspace as Record<
				string,
				unknown
			>;

			const close = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: {path: workspace.path},
				headers: fixture.create_session_headers(),
			});
			assert.ok(close.ok);
			assert.equal(close.result, null, 'close result is null');

			const list = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_list',
				headers: fixture.create_session_headers(),
			});
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
				Record<string, unknown>
			>;
			assert.ok(!workspaces.some((w) => w.path === workspace.path), 'workspace gone');

			const close2 = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: {path: workspace.path},
				headers: fixture.create_session_headers(),
			});
			assert.ok(!close2.ok, 'double close should fail');
			assert.equal(close2.error.code, -32602);
			assert.ok(
				close2.error.message.startsWith('workspace not open:'),
				`unexpected message: ${close2.error.message}`,
			);
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_not_directory', async () => {
		const fixture = await setup_test();
		const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;
		const file_path = join(scoped_dir, `not_a_dir_${randomUUID()}.txt`);
		await mkdir(scoped_dir, {recursive: true});
		try {
			await writeFile(file_path, 'content', 'utf-8');
			const res = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: file_path},
				headers: fixture.create_session_headers(),
			});
			assert.ok(!res.ok, 'expected error opening a file as workspace');
			assert.equal(res.error.code, -32603);
		} finally {
			await rm(file_path, {force: true});
		}
	});

	test('workspace_changed_on_open', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fetch_transport(fixture.transport).cookies(),
		});
		const tmp_dir = await create_tmp_workspace('changed_open');
		try {
			// Warm-up ping to ensure the connection is registered.
			await ws.request('_warmup', 'ping', undefined);

			const open = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(open.ok);

			const notification = (await ws.wait_for(
				is_notification('workspace_changed'),
				5_000,
			)) as Record<string, unknown>;
			const params = notification.params as Record<string, unknown>;
			assert.equal(params.type, 'open');
			const workspace = params.workspace as Record<string, unknown>;
			assert.equal(typeof workspace.path, 'string');
			assert.ok((workspace.path as string).endsWith('/'), 'path ends with /');
			assert.equal(typeof workspace.name, 'string');
			assert.equal(typeof workspace.opened_at, 'string');
		} finally {
			await ws.close();
			await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			}).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_changed_on_close', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('changed_close');
		try {
			const open = await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(open.ok);
			const workspace = (open.result as Record<string, unknown>).workspace as Record<
				string,
				unknown
			>;

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fetch_transport(fixture.transport).cookies(),
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				const close = await rpc_call({
					app: as_rpc_app(fixture.transport),
					path: handle.config.rpc_path,
					method: 'workspace_close',
					params: {path: workspace.path},
					headers: fixture.create_session_headers(),
				});
				assert.ok(close.ok);

				const notification = (await ws.wait_for(
					is_notification('workspace_changed'),
					5_000,
				)) as Record<string, unknown>;
				const params = notification.params as Record<string, unknown>;
				assert.equal(params.type, 'close');
				const info = params.workspace as Record<string, unknown>;
				assert.equal(info.path, workspace.path, 'same workspace path');
			} finally {
				await ws.close();
			}
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_changed_idempotent_no_notification', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('changed_idempotent');
		try {
			await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fetch_transport(fixture.transport).cookies(),
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				await rpc_call({
					app: as_rpc_app(fixture.transport),
					path: handle.config.rpc_path,
					method: 'workspace_open',
					params: {path: tmp_dir},
					headers: fixture.create_session_headers(),
				});

				// Idempotent open should NOT trigger workspace_changed — verify silence.
				let saw_workspace_changed = false;
				try {
					await ws.wait_for(is_notification('workspace_changed'), 500);
					saw_workspace_changed = true;
				} catch {
					// expected timeout
				}
				assert.ok(
					!saw_workspace_changed,
					'idempotent open must not trigger workspace_changed',
				);
			} finally {
				await ws.close();
			}
		} finally {
			await rpc_call({
				app: as_rpc_app(fixture.transport),
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			}).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});
});

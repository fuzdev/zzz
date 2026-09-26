/**
 * Cross-backend integration tests for `workspace_*` actions.
 *
 * Each test mints a fresh per-test account via
 * `default_cross_process_setup` and drives RPC + WS frames against the
 * spawned test binary specified by the `backend_handle` injected from
 * `globalSetup`.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_notification } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';

import { ERROR_WORKSPACE_NOT_OPEN } from '$lib/workspace_helpers.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

/** Create a fresh tmp directory for a workspace; caller cleans up. */
const create_tmp_workspace = async (label: string): Promise<string> => {
	const dir = join(tmpdir(), `zzz_cross_ws_${label}_${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
};

const remove_dir = async (path: string): Promise<void> => {
	await rm(path, { recursive: true, force: true });
};

/**
 * `chmod 000` `path`, returning whether the OS enforces it — it doesn't for
 * root, and the caller then has nothing to check. The caller restores the
 * mode (`chmod 0o755`) before cleanup.
 */
const lock_dir = async (path: string): Promise<boolean> => {
	await chmod(path, 0o000);
	try {
		await readdir(path);
		return false;
	} catch {
		return true;
	}
};

const zzz_dir = handle.config.env.PUBLIC_ZZZ_DIR!;
const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;

type CrossFixture = Awaited<ReturnType<typeof setup_test>>;

const call = (fixture: CrossFixture, method: string, params?: Record<string, unknown>) =>
	rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method,
		params,
		headers: fixture.create_session_headers()
	});

/** Open `path` as a workspace and return the daemon's canonical workspace path. */
const open_workspace = async (fixture: CrossFixture, path: string): Promise<string> => {
	const open = await call(fixture, 'workspace_open', { path });
	assert.ok(open.ok, `workspace_open failed: ${JSON.stringify(open)}`);
	const workspace = (open.result as Record<string, unknown>).workspace as Record<string, unknown>;
	return workspace.path as string;
};

const close_workspace = async (fixture: CrossFixture, path: string): Promise<void> => {
	const close = await call(fixture, 'workspace_close', { path });
	assert.ok(close.ok, `workspace_close failed: ${JSON.stringify(close)}`);
};

/** Assert `diskfile_update` can write `file_path` (then remove it). */
const assert_writable = async (fixture: CrossFixture, file_path: string): Promise<void> => {
	try {
		const res = await call(fixture, 'diskfile_update', { path: file_path, content: 'still here' });
		assert.ok(res.ok, `diskfile_update failed for ${file_path}: ${JSON.stringify(res)}`);
		assert.equal(await readFile(file_path, 'utf-8'), 'still here');
	} finally {
		await rm(file_path, { force: true });
	}
};

const assert_not_writable = async (fixture: CrossFixture, file_path: string): Promise<void> => {
	const res = await call(fixture, 'diskfile_update', { path: file_path, content: 'nope' });
	assert.ok(!res.ok, `expected out-of-scope write to fail: ${file_path}`);
	assert.ok(
		res.error.message.startsWith('failed to write file: Path is not allowed'),
		`unexpected message: ${res.error.message}`
	);
};

describe('workspace cross-backend', () => {
	test('workspace_open_and_list', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('open_list');
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
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
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_list',
				headers: fixture.create_session_headers()
			});
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
				Record<string, unknown>
			>;
			assert.ok(
				workspaces.some((w) => w.path === workspace.path),
				'opened workspace in list'
			);
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_idempotent', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('idempotent');
		try {
			const r1 = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(r1.ok);
			const w1 = (r1.result as Record<string, unknown>).workspace as Record<string, unknown>;

			const r2 = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(r2.ok);
			const w2 = (r2.result as Record<string, unknown>).workspace as Record<string, unknown>;

			assert.equal(w1.opened_at, w2.opened_at, 'same opened_at');
			assert.equal(w1.path, w2.path, 'same path');
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_returns_files', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('files');
		try {
			await mkdir(join(tmp_dir, 'sub'), { recursive: true });
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			await writeFile(join(tmp_dir, 'sub', 'b.txt'), 'beta', 'utf-8');
			// symlinks are skipped entirely — a loop must not hang the scan
			await symlink('..', join(tmp_dir, 'sub', 'up'));
			await symlink(join(tmp_dir, 'a.txt'), join(tmp_dir, 'link.txt'));

			const open_files = async (): Promise<Map<string, unknown>> => {
				const open = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'workspace_open',
					params: { path: tmp_dir },
					headers: fixture.create_session_headers()
				});
				assert.ok(open.ok, `workspace_open failed: ${JSON.stringify(open)}`);
				const files = (open.result as Record<string, unknown>).files as Array<
					Record<string, unknown>
				>;
				return new Map(files.map((f) => [f.id as string, f.contents]));
			};

			const expected = new Map([
				[join(tmp_dir, 'a.txt'), 'alpha'],
				[join(tmp_dir, 'sub', 'b.txt'), 'beta']
			]);
			const open = await call(fixture, 'workspace_open', { path: tmp_dir });
			assert.ok(open.ok, `workspace_open failed: ${JSON.stringify(open)}`);
			assert.equal((open.result as Record<string, unknown>).watch_status, 'full');
			// concurrent opens both get the fully scanned tree
			const [first, second] = await Promise.all([open_files(), open_files()]);
			assert.deepEqual(first, expected, 'first open');
			assert.deepEqual(second, expected, 'concurrent open');
			assert.deepEqual(await open_files(), expected, 'idempotent open');
		} finally {
			await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_skips_unreadable_subdirectories', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('unreadable_sub');
		const locked = join(tmp_dir, 'locked');
		try {
			await mkdir(join(locked, 'inner'), { recursive: true });
			await writeFile(join(locked, 'secret.txt'), 'secret', 'utf-8');
			await mkdir(join(tmp_dir, 'open'), { recursive: true });
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			await writeFile(join(tmp_dir, 'open', 'b.txt'), 'beta', 'utf-8');
			if (!(await lock_dir(locked))) return;

			const open = await call(fixture, 'workspace_open', { path: tmp_dir });
			assert.ok(open.ok, `workspace_open failed: ${JSON.stringify(open)}`);
			const result = open.result as Record<string, unknown>;
			const files = result.files as Array<Record<string, unknown>>;
			assert.deepEqual(
				new Map(files.map((f) => [f.id as string, f.contents])),
				new Map([
					[join(tmp_dir, 'a.txt'), 'alpha'],
					[join(tmp_dir, 'open', 'b.txt'), 'beta']
				])
			);
			assert.equal(result.watch_status, 'full');
		} finally {
			await chmod(locked, 0o755).catch(() => undefined);
			await call(fixture, 'workspace_close', { path: tmp_dir }).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_unreadable_root', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('unreadable_root');
		try {
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			if (!(await lock_dir(tmp_dir))) return;

			const res = await call(fixture, 'workspace_open', { path: tmp_dir });
			assert.ok(!res.ok, 'expected an unreadable root to fail');
			assert.equal(res.error.code, -32002);
			assert.deepEqual(res.error.data, { reason: 'permission_denied' });
			assert.ok(
				res.error.message.startsWith('failed to open workspace: permission denied:'),
				`unexpected message: ${res.error.message}`
			);
			// nothing was registered
			const list = await call(fixture, 'workspace_list');
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
				Record<string, unknown>
			>;
			assert.ok(!workspaces.some((w) => w.path === `${tmp_dir}/`));
		} finally {
			await chmod(tmp_dir, 0o755).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_refuses_zzz_homes', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('zzz_home');
		const home = join(tmp_dir, '.zzz');
		try {
			await mkdir(join(home, 'run'), { recursive: true });
			await writeFile(join(home, '.env'), 'SECRET_FUZ_COOKIE_KEYS=not-for-a-workspace', 'utf-8');
			await symlink(home, join(tmp_dir, 'home_link'));

			// the daemon home, a directory inside it, and a symlink to it
			for (const path of [home, join(home, 'run'), join(tmp_dir, 'home_link')]) {
				const res = await call(fixture, 'workspace_open', { path });
				assert.ok(!res.ok, `expected ${path} to be refused`);
				assert.equal(res.error.code, -32002, path);
				assert.deepEqual(res.error.data, { reason: 'zzz_home_not_allowed' }, path);
			}
			const list = await call(fixture, 'workspace_list');
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
				Record<string, unknown>
			>;
			assert.ok(!workspaces.some((w) => (w.path as string).startsWith(home)), 'nothing opened');

			// its parent opens, with the `.zzz` directory skipped
			const open = await call(fixture, 'workspace_open', { path: tmp_dir });
			assert.ok(open.ok, `workspace_open failed: ${JSON.stringify(open)}`);
			const files = (open.result as Record<string, unknown>).files as Array<
				Record<string, unknown>
			>;
			assert.ok(!files.some((f) => (f.id as string).startsWith(home)), 'home not indexed');
		} finally {
			await call(fixture, 'workspace_close', { path: tmp_dir }).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_malformed_paths_are_invalid_params', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('malformed');
		try {
			await symlink(join(tmp_dir, 'b'), join(tmp_dir, 'a'));
			await symlink(join(tmp_dir, 'a'), join(tmp_dir, 'b'));
			for (const path of [
				`${tmp_dir}/nul\0byte`,
				join(tmp_dir, 'a'),
				join(tmp_dir, 'x'.repeat(300))
			]) {
				const res = await call(fixture, 'workspace_open', { path });
				assert.ok(!res.ok, `expected ${JSON.stringify(path)} to fail`);
				assert.equal(res.error.code, -32602, JSON.stringify(path));
				assert.deepEqual(res.error.data, { reason: 'invalid_path' }, JSON.stringify(path));
			}
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_nonexistent', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'workspace_open',
			params: { path: `/tmp/zzz_nonexistent_${randomUUID()}` },
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, 'expected error');
		assert.equal(res.error.code, -32003);
		assert.deepEqual(res.error.data, { reason: 'path_not_found' });
		assert.ok(
			res.error.message.startsWith('failed to open workspace: directory does not exist:'),
			`unexpected message: ${res.error.message}`
		);
	});

	test('workspace_close', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('close');
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(open.ok);
			const workspace = (open.result as Record<string, unknown>).workspace as Record<
				string,
				unknown
			>;

			const close = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: workspace.path },
				headers: fixture.create_session_headers()
			});
			assert.ok(close.ok);
			assert.equal(close.result, null, 'close result is null');

			const list = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_list',
				headers: fixture.create_session_headers()
			});
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
				Record<string, unknown>
			>;
			assert.ok(!workspaces.some((w) => w.path === workspace.path), 'workspace gone');

			const close2 = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: workspace.path },
				headers: fixture.create_session_headers()
			});
			assert.ok(!close2.ok, 'double close should fail');
			assert.equal(close2.error.code, -32602);
			assert.ok(
				close2.error.message.startsWith('workspace not open:'),
				`unexpected message: ${close2.error.message}`
			);
			assert.deepEqual(close2.error.data, { reason: ERROR_WORKSPACE_NOT_OPEN });
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_not_directory', async () => {
		const fixture = await setup_test();
		const file_path = join(scoped_dir, `not_a_dir_${randomUUID()}.txt`);
		await mkdir(scoped_dir, { recursive: true });
		try {
			await writeFile(file_path, 'content', 'utf-8');
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: file_path },
				headers: fixture.create_session_headers()
			});
			assert.ok(!res.ok, 'expected error opening a file as workspace');
			assert.equal(res.error.code, -32602);
			assert.deepEqual(res.error.data, { reason: 'not_a_directory' });
		} finally {
			await rm(file_path, { force: true });
		}
	});

	test('workspace_changed_on_open', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		const tmp_dir = await create_tmp_workspace('changed_open');
		try {
			// Warm-up ping to ensure the connection is registered.
			await ws.request('_warmup', 'ping', undefined);

			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(open.ok);

			const notification = await ws.wait_for<Record<string, unknown>>(
				is_notification('workspace_changed'),
				5_000
			);
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
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_changed_on_close', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('changed_close');
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(open.ok);
			const workspace = (open.result as Record<string, unknown>).workspace as Record<
				string,
				unknown
			>;

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies()
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				const close = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'workspace_close',
					params: { path: workspace.path },
					headers: fixture.create_session_headers()
				});
				assert.ok(close.ok);

				const notification = await ws.wait_for<Record<string, unknown>>(
					is_notification('workspace_changed'),
					5_000
				);
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
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies()
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'workspace_open',
					params: { path: tmp_dir },
					headers: fixture.create_session_headers()
				});

				// Idempotent open should NOT trigger workspace_changed — verify silence.
				let saw_workspace_changed = false;
				try {
					await ws.wait_for(is_notification('workspace_changed'), 500);
					saw_workspace_changed = true;
				} catch {
					// expected timeout
				}
				assert.ok(!saw_workspace_changed, 'idempotent open must not trigger workspace_changed');
			} finally {
				await ws.close();
			}
		} finally {
			await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_close_on_zzz_dir_keeps_write_access', async () => {
		const fixture = await setup_test();
		await mkdir(zzz_dir, { recursive: true });
		const path = await open_workspace(fixture, zzz_dir);
		await close_workspace(fixture, path);
		await assert_writable(fixture, join(zzz_dir, `after_close_${randomUUID()}.txt`));
	});

	test('workspace_close_on_scoped_dir_keeps_write_access', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, { recursive: true });
		// a non-canonical spelling opens and closes the canonical workspace
		const spelled = `${scoped_dir}/./`;
		const path = await open_workspace(fixture, spelled);
		assert.ok(!path.endsWith('/./'), `path is canonical: ${path}`);
		await close_workspace(fixture, spelled);

		const list = await call(fixture, 'workspace_list');
		assert.ok(list.ok);
		const workspaces = (list.result as Record<string, unknown>).workspaces as Array<
			Record<string, unknown>
		>;
		assert.ok(!workspaces.some((w) => w.path === path), 'workspace closed');

		await assert_writable(fixture, join(scoped_dir, `after_close_${randomUUID()}.txt`));
	});

	test('workspace_close_nested_in_scoped_dir_keeps_write_access', async () => {
		const fixture = await setup_test();
		const nested = join(scoped_dir, `nested_ws_${randomUUID()}`);
		await mkdir(nested, { recursive: true });
		try {
			const path = await open_workspace(fixture, nested);
			await close_workspace(fixture, path);
			await assert_writable(fixture, join(nested, 'after_close.txt'));
		} finally {
			await remove_dir(nested);
		}
	});

	test('workspace_close_revokes_its_own_scope', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('revoke');
		try {
			const path = await open_workspace(fixture, tmp_dir);
			await assert_writable(fixture, join(tmp_dir, 'while_open.txt'));
			await close_workspace(fixture, path);
			await assert_not_writable(fixture, join(tmp_dir, 'after_close.txt'));
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('testing_reset_closes_workspaces_and_restores_scope', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_workspace('reset');
		try {
			// left open on purpose — the next reset must release it
			await open_workspace(fixture, tmp_dir);
			await open_workspace(fixture, zzz_dir);
			await assert_writable(fixture, join(tmp_dir, 'while_open.txt'));

			const after_reset = await setup_test();
			const list = await call(after_reset, 'workspace_list');
			assert.ok(list.ok);
			const workspaces = (list.result as Record<string, unknown>).workspaces as Array<unknown>;
			assert.equal(workspaces.length, 0, 'reset closes every workspace');

			await assert_not_writable(after_reset, join(tmp_dir, 'after_reset.txt'));
			await assert_writable(after_reset, join(zzz_dir, `after_reset_${randomUUID()}.txt`));
			await assert_writable(after_reset, join(scoped_dir, `after_reset_${randomUUID()}.txt`));
		} finally {
			await remove_dir(tmp_dir);
		}
	});

	test('workspace_open_and_close_reject_non_absolute_paths', async () => {
		const fixture = await setup_test();
		for (const method of ['workspace_open', 'workspace_close']) {
			for (const path of ['', '.', 'relative/dir', '~/dev']) {
				const res = await call(fixture, method, { path });
				assert.ok(!res.ok, `${method} should reject ${JSON.stringify(path)}`);
				assert.equal(res.error.code, -32602, `${method} ${JSON.stringify(path)}`);
			}
		}
	});
});

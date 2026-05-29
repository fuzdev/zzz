/**
 * Cross-backend integration tests for provider + session_load actions.
 *
 * The keeper-only `provider_update_api_key` action requires daemon-token
 * auth and is not yet ported — see the TODO at the bottom.
 *
 * @module
 */

import {join} from 'node:path';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {describe, test, inject, assert} from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {rpc_call} from '@fuzdev/fuz_app/testing/rpc_helpers.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

const zzz_dir = handle.config.env.PUBLIC_ZZZ_DIR!;

describe('provider + session cross-backend', () => {
	test('provider_load_status_empty', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'provider_load_status',
			params: {provider_name: 'gemini'},
			headers: fixture.create_session_headers(),
		});
		assert.ok(res.ok, `provider_load_status failed: ${JSON.stringify(res)}`);
		const status = (res.result as Record<string, unknown>).status as Record<string, unknown>;
		assert.equal(status.name, 'gemini');
		assert.equal(typeof status.available, 'boolean');
		assert.equal(typeof status.checked_at, 'number');
		if (status.available === false) {
			assert.equal(typeof status.error, 'string');
		}
	});

	test('session_load_basic', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'session_load',
			headers: fixture.create_session_headers(),
		});
		assert.ok(res.ok);
		const data = (res.result as Record<string, unknown>).data as Record<string, unknown>;

		const zzz_dir_out = data.zzz_dir as string;
		assert.ok(zzz_dir_out.startsWith('/'), 'zzz_dir is absolute');
		assert.ok(zzz_dir_out.endsWith('/'), 'zzz_dir has trailing slash');

		const scoped_dirs = data.scoped_dirs as Array<string>;
		assert.ok(scoped_dirs.length >= 1, `scoped_dirs has entries (got ${scoped_dirs.length})`);
		const first = scoped_dirs[0]!;
		assert.ok(first.startsWith('/'), 'scoped_dirs[0] is absolute');
		assert.ok(first.endsWith('/'), 'scoped_dirs[0] has trailing slash');

		assert.ok(Array.isArray(data.files), 'files is array');
		assert.ok(Array.isArray(data.provider_status), 'provider_status is array');
		assert.ok(Array.isArray(data.workspaces), 'workspaces is array');
	});

	test('session_load_returns_zzz_dir_files', async () => {
		const fixture = await setup_test();
		await mkdir(zzz_dir, {recursive: true});
		const file_name = `test_session_${randomUUID()}.txt`;
		const file_path = join(zzz_dir, file_name);
		const content = 'session load file test';
		try {
			await writeFile(file_path, content, 'utf-8');

			// Read-after-write race: the Filer indexes a newly-detected file
			// before its content load completes, so an immediate `session_load`
			// can snapshot the entry with `contents: null`. Poll until the
			// watcher has loaded the contents (or time out). The exact timing
			// is nondeterministic (async watcher + content load), so a fixed
			// single call is flaky; the poll makes it deterministic.
			// (Cross-process analog of `wait_for_audit_row`; mirrors
			// `session_load_returns_nested_files` below.)
			let test_file: Record<string, unknown> | undefined;
			const deadline = Date.now() + 5_000;
			for (;;) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'session_load',
					headers: fixture.create_session_headers(),
				});
				assert.ok(res.ok);
				const data = (res.result as Record<string, unknown>).data as Record<string, unknown>;
				const files = data.files as Array<Record<string, unknown>>;
				test_file = files.find((f) => (f.id as string).endsWith(`/${file_name}`));
				if (test_file?.contents === content) break;
				if (Date.now() > deadline) {
					if (!test_file) {
						const ids = files.map((f) => f.id);
						assert.fail(`test file not found in ${files.length} files: ${JSON.stringify(ids)}`);
					}
					break; // fall through to the assertion below for a clear diff
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(test_file.contents, content);
			assert.ok((test_file.source_dir as string).startsWith('/'), 'source_dir absolute');
			assert.ok((test_file.source_dir as string).endsWith('/'), 'source_dir trailing slash');
			assert.ok((test_file.id as string).startsWith('/'), 'file id absolute');
			assert.deepEqual(test_file.dependents, []);
			assert.deepEqual(test_file.dependencies, []);
			assert.equal(typeof test_file.mtime, 'number');
		} finally {
			await rm(file_path, {force: true});
		}
	});

	test('session_load_returns_nested_files', async () => {
		const fixture = await setup_test();
		const sub_dir = join(zzz_dir, 'state', `nested_${randomUUID()}`);
		await mkdir(sub_dir, {recursive: true});
		const file_path = join(sub_dir, 'deep.txt');
		try {
			await writeFile(file_path, 'nested content', 'utf-8');

			// Read-after-write race: the Filer indexes a newly-detected nested
			// file before its content load completes, so an immediate
			// `session_load` can snapshot the entry with `contents: null`.
			// Poll until the watcher has loaded the contents (or time out).
			// The exact timing is nondeterministic (async watcher + content
			// load), so a fixed single call is flaky; the poll makes it
			// deterministic. (Cross-process analog of `wait_for_audit_row`.)
			let nested: Record<string, unknown> | undefined;
			const deadline = Date.now() + 5_000;
			for (;;) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'session_load',
					headers: fixture.create_session_headers(),
				});
				assert.ok(res.ok);
				const data = (res.result as Record<string, unknown>).data as Record<string, unknown>;
				const files = data.files as Array<Record<string, unknown>>;
				nested = files.find((f) => (f.id as string).endsWith('/deep.txt'));
				if (nested?.contents === 'nested content') break;
				if (Date.now() > deadline) {
					if (!nested) {
						const ids = files.map((f) => f.id);
						assert.fail(`nested file not found in ${files.length} files: ${JSON.stringify(ids)}`);
					}
					break; // fall through to the assertion below for a clear diff
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(nested.contents, 'nested content');
		} finally {
			await rm(sub_dir, {recursive: true, force: true});
		}
	});

	// TODO: provider_update_api_key is keeper-only — it requires the
	// daemon-token credential type rather than a session cookie. Driving
	// it cross-process needs `handle.keeper_transport` plus
	// `fixture.create_daemon_token_headers()`; per-test scoping for
	// keeper-driven actions is the parent agent's call once the
	// daemon-token header pattern lands. Skipped intentionally — see
	// `auth_keeper_forbidden` in the old runner for the negative case.
});

/**
 * Cross-backend integration tests for the `project_*` actions on plain
 * directories and git checkouts under the temp root, and the refusals; a
 * registry under a trusted home is `project_registry.cross.test.ts`'s.
 *
 * Each test mints a fresh per-test account via
 * `default_cross_process_setup` and drives RPC + WS frames against the
 * spawned test binary specified by the `backend_handle` injected from
 * `globalSetup`.
 *
 * @module
 */

import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, assert, onTestFinished } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_notification } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';

import { ERROR_PROJECT_NOT_OPEN } from '#lib/project_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

const remove_dir = async (path: string): Promise<void> => {
	await rm(path, { recursive: true, force: true });
};

/**
 * Create a fresh tmp directory for a project, inside a running test. The
 * caller cleans up in a `finally`; the directory is also removed once the
 * test finishes, which covers a test that times out — its body, and so its
 * `finally`, may still be waiting on the backend when the run moves on.
 */
const create_tmp_project = async (label: string): Promise<string> => {
	const dir = join(tmpdir(), `zzz_cross_ws_${label}_${randomUUID()}`);
	onTestFinished(() => remove_dir(dir).catch(() => undefined));
	await mkdir(dir, { recursive: true });
	return dir;
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

/** Open the project holding `path` and return the daemon's canonical root. */
const open_project = async (fixture: CrossFixture, path: string): Promise<string> => {
	const open = await call(fixture, 'project_open', { path });
	assert.ok(open.ok, `project_open failed: ${JSON.stringify(open)}`);
	const project = (open.result as Record<string, unknown>).project as Record<string, unknown>;
	return project.root as string;
};

const close_project = async (fixture: CrossFixture, root: string): Promise<void> => {
	const close = await call(fixture, 'project_close', { root });
	assert.ok(close.ok, `project_close failed: ${JSON.stringify(close)}`);
};

/** The roots of the open projects. */
const list_roots = async (fixture: CrossFixture): Promise<Array<string>> => {
	const list = await call(fixture, 'project_list');
	assert.ok(list.ok);
	const projects = (list.result as Record<string, unknown>).projects as Array<
		Record<string, unknown>
	>;
	return projects.map((p) => p.root as string);
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

/** `res`'s error, asserting it failed. */
const error_of = (res: Awaited<ReturnType<typeof call>>, label: string) => {
	assert.ok(!res.ok, `expected ${label} to fail`);
	return res.error;
};

const result_of = (res: Awaited<ReturnType<typeof call>>, label: string) => {
	assert.ok(res.ok, `${label} failed: ${JSON.stringify(res)}`);
	return res.result as Record<string, unknown>;
};

describe('project cross-backend', () => {
	test('project_open_and_list', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('open_list');
		try {
			const result = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
			const project = result.project as Record<string, unknown>;
			assert.equal(project.root, `${tmp_dir}/`);
			assert.equal(typeof project.name, 'string');
			assert.equal(typeof project.opened_at, 'string');
			assert.equal(project.kind, 'plain_dir');
			assert.equal(project.registry_path, null);
			assert.deepEqual(project.entries, []);
			assert.deepEqual(project.focused, [`${tmp_dir}/`]);
			assert.equal(result.focus, `${tmp_dir}/`);
			assert.ok(Array.isArray(result.files), 'files is array');
			assert.include(await list_roots(fixture), `${tmp_dir}/`);
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_idempotent', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('idempotent');
		try {
			const p1 = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'first')
				.project as Record<string, unknown>;
			const p2 = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'second')
				.project as Record<string, unknown>;
			assert.equal(p1.opened_at, p2.opened_at, 'same opened_at');
			assert.equal(p1.root, p2.root, 'same root');
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_returns_files', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('files');
		try {
			await mkdir(join(tmp_dir, 'sub'), { recursive: true });
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			await writeFile(join(tmp_dir, 'sub', 'b.txt'), 'beta', 'utf-8');
			// symlinks are skipped entirely — a loop must not hang the scan
			await symlink('..', join(tmp_dir, 'sub', 'up'));
			await symlink(join(tmp_dir, 'a.txt'), join(tmp_dir, 'link.txt'));

			const open_files = async (): Promise<Map<string, unknown>> => {
				const result = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
				const files = result.files as Array<Record<string, unknown>>;
				for (const file of files) assert.notProperty(file, 'contents', String(file.id));
				return new Map(files.map((f) => [f.id as string, f.size]));
			};

			// metadata only: each file's size, no contents
			const expected = new Map([
				[join(tmp_dir, 'a.txt'), 'alpha'.length],
				[join(tmp_dir, 'sub', 'b.txt'), 'beta'.length]
			]);
			const result = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
			assert.equal(result.watch_status, 'full');
			// concurrent opens both get the fully scanned tree
			const [first, second] = await Promise.all([open_files(), open_files()]);
			assert.deepEqual(first, expected, 'first open');
			assert.deepEqual(second, expected, 'concurrent open');
			assert.deepEqual(await open_files(), expected, 'idempotent open');
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_of_a_file_opens_its_directory', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('file');
		try {
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			const result = result_of(
				await call(fixture, 'project_open', { path: join(tmp_dir, 'a.txt') }),
				'open'
			);
			assert.equal((result.project as Record<string, unknown>).root, `${tmp_dir}/`);
			assert.equal(result.focus, `${tmp_dir}/`);
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_in_a_git_checkout_roots_at_the_checkout', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('git');
		try {
			// a `.git` that stats is a checkout, as discovery reads one
			await mkdir(join(tmp_dir, '.git'), { recursive: true });
			await mkdir(join(tmp_dir, 'src', 'deep'), { recursive: true });
			await writeFile(join(tmp_dir, 'src', 'a.ts'), 'a', 'utf-8');
			await writeFile(join(tmp_dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
			const result = result_of(
				await call(fixture, 'project_open', { path: join(tmp_dir, 'src', 'deep') }),
				'open'
			);
			const project = result.project as Record<string, unknown>;
			assert.equal(project.root, `${tmp_dir}/`);
			assert.equal(project.kind, 'git_repo');
			assert.deepEqual(project.focused, [`${tmp_dir}/`]);
			const ids = (result.files as Array<Record<string, unknown>>).map((f) => f.id);
			assert.deepEqual(ids, [join(tmp_dir, 'src', 'a.ts')], '.git is never indexed');
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_refuses_an_untrusted_registry_with_its_reason', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('untrusted');
		const writable = join(tmp_dir, 'shared');
		try {
			await mkdir(join(writable, 'app'), { recursive: true });
			await writeFile(
				join(writable, 'repos.toml'),
				'owners = ["me"]\n\n[repos.app]\nurl = "https://github.com/me/app"\nvisibility = "public"\npurpose = "an app"\n',
				'utf-8'
			);
			// anyone may write the registry's directory: another user could plant it
			await chmod(writable, 0o777);
			const error = error_of(
				await call(fixture, 'project_open', { path: join(writable, 'app') }),
				'an untrusted registry'
			);
			assert.equal(error.code, -32002);
			assert.deepEqual(error.data, { reason: 'registry_untrusted' });
			assert.ok(error.message.startsWith('failed to open project: '), error.message);
			assert.notInclude(await list_roots(fixture), `${writable}/`, 'nothing opened');
		} finally {
			await chmod(writable, 0o755).catch(() => undefined);
		}
	});

	test('project_open_skips_unreadable_subdirectories', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('unreadable_sub');
		const locked = join(tmp_dir, 'locked');
		try {
			await mkdir(join(locked, 'inner'), { recursive: true });
			await writeFile(join(locked, 'secret.txt'), 'secret', 'utf-8');
			await mkdir(join(tmp_dir, 'open'), { recursive: true });
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			await writeFile(join(tmp_dir, 'open', 'b.txt'), 'beta', 'utf-8');
			if (!(await lock_dir(locked))) return;

			const result = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
			const files = result.files as Array<Record<string, unknown>>;
			assert.deepEqual(
				new Map(files.map((f) => [f.id as string, f.size])),
				new Map([
					[join(tmp_dir, 'a.txt'), 'alpha'.length],
					[join(tmp_dir, 'open', 'b.txt'), 'beta'.length]
				])
			);
			assert.equal(result.watch_status, 'full');
		} finally {
			await chmod(locked, 0o755).catch(() => undefined);
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_unreadable_root', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('unreadable_root');
		try {
			await writeFile(join(tmp_dir, 'a.txt'), 'alpha', 'utf-8');
			if (!(await lock_dir(tmp_dir))) return;

			const error = error_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
			assert.equal(error.code, -32002);
			assert.ok(error.message.startsWith('failed to open project: '), error.message);
			// nothing was registered
			assert.notInclude(await list_roots(fixture), `${tmp_dir}/`);
		} finally {
			await chmod(tmp_dir, 0o755).catch(() => undefined);
		}
	});

	test('project_open_refuses_zzz_homes', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('zzz_home');
		const home = join(tmp_dir, '.zzz');
		try {
			await mkdir(join(home, 'run'), { recursive: true });
			await writeFile(join(home, '.env'), 'SECRET_FUZ_COOKIE_KEYS=not-for-a-project', 'utf-8');
			await symlink(home, join(tmp_dir, 'home_link'));

			// the daemon home, a directory inside it, a file in it, and a symlink to it
			for (const path of [
				home,
				join(home, 'run'),
				join(home, '.env'),
				join(tmp_dir, 'home_link')
			]) {
				const error = error_of(await call(fixture, 'project_open', { path }), path);
				assert.equal(error.code, -32002, path);
				assert.deepEqual(error.data, { reason: 'protected_dir_not_allowed' }, path);
			}
			const roots = await list_roots(fixture);
			assert.ok(!roots.some((root) => root.startsWith(home)), 'nothing opened');

			// its parent opens, with the `.zzz` directory skipped
			const result = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
			const files = result.files as Array<Record<string, unknown>>;
			assert.ok(!files.some((f) => (f.id as string).startsWith(home)), 'home not indexed');
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_open_refuses_credential_dirs', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('credentials');
		const ssh = join(tmp_dir, '.ssh');
		try {
			await mkdir(join(ssh, 'sub'), { recursive: true });
			await writeFile(join(ssh, 'id_ed25519'), 'not-for-a-project', 'utf-8');
			await mkdir(join(tmp_dir, 'project', '.aws'), { recursive: true });
			await writeFile(join(tmp_dir, 'project', '.aws', 'credentials'), 'x', 'utf-8');
			await writeFile(join(tmp_dir, 'project', '.env'), 'X=1', 'utf-8');
			await symlink(ssh, join(tmp_dir, 'ssh_link'));

			// the directory, one inside it, a symlink to it, and another name
			for (const path of [
				ssh,
				join(ssh, 'sub'),
				join(ssh, 'id_ed25519'),
				join(tmp_dir, 'ssh_link'),
				join(tmp_dir, 'project', '.aws')
			]) {
				const error = error_of(await call(fixture, 'project_open', { path }), path);
				assert.equal(error.code, -32002, path);
				assert.deepEqual(error.data, { reason: 'protected_dir_not_allowed' }, path);
			}

			// its parent opens, with the credential directories skipped and
			// `.env` files indexed
			const result = result_of(await call(fixture, 'project_open', { path: tmp_dir }), 'open');
			const ids = (result.files as Array<Record<string, unknown>>)
				.map((f) => f.id as string)
				.sort();
			assert.deepEqual(ids, [join(tmp_dir, 'project', '.env')]);
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	// the backend inherits this process's `HOME`; its temp roots are
	// allowlisted (`ZZZ_ROOTS_OUTSIDE_HOME`), so these probe directories
	// outside both
	test('project_open_refuses_home_its_ancestors_and_pseudo_filesystems', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('home');
		const home = homedir();
		await symlink(home, join(tmp_dir, 'home_link'));
		await symlink('/', join(tmp_dir, 'slash_link'));
		for (const path of [
			home,
			`${home}/`,
			`${home}/.`,
			join(tmp_dir, 'home_link'),
			dirname(home),
			'/',
			join(tmp_dir, 'slash_link'),
			'/proc',
			'/proc/self',
			'/sys',
			'/dev'
		]) {
			const error = error_of(await call(fixture, 'project_open', { path }), path);
			assert.equal(error.code, -32002, path);
			assert.deepEqual(error.data, { reason: 'root_not_allowed' }, path);
		}
		const opened = (await list_roots(fixture)).filter(
			(p) => `${home}/`.startsWith(p) || /^\/(proc|sys|dev)\//.test(p)
		);
		assert.deepEqual(opened, [], 'nothing opened');
	});

	test('project_open_refuses_roots_outside_home_not_allowlisted', async () => {
		const fixture = await setup_test();
		const home = homedir();
		const outside = ['/etc', '/usr/share'].filter(
			(dir) => !dir.startsWith(`${home}/`) && !dir.startsWith(`${tmpdir()}/`)
		);
		assert.isNotEmpty(outside);
		for (const path of outside) {
			const error = error_of(await call(fixture, 'project_open', { path }), path);
			assert.equal(error.code, -32002, path);
			assert.deepEqual(error.data, { reason: 'root_outside_home' }, path);
			assert.include(error.message, 'ZZZ_ROOTS_OUTSIDE_HOME', path);
		}
	});

	test('project_open_malformed_paths_are_invalid_params', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('malformed');
		await symlink(join(tmp_dir, 'b'), join(tmp_dir, 'a'));
		await symlink(join(tmp_dir, 'a'), join(tmp_dir, 'b'));
		// a NUL byte never reaches the handler: the dispatcher refuses any params holding one
		for (const [path, reason] of [
			[`${tmp_dir}/nul\0byte`, 'params_nul'],
			[join(tmp_dir, 'a'), 'invalid_path'],
			[join(tmp_dir, 'x'.repeat(300)), 'invalid_path']
		] as const) {
			const error = error_of(await call(fixture, 'project_open', { path }), JSON.stringify(path));
			assert.equal(error.code, -32602, JSON.stringify(path));
			assert.deepEqual(error.data, { reason }, JSON.stringify(path));
		}
	});

	test('project_open_nonexistent', async () => {
		const fixture = await setup_test();
		const error = error_of(
			await call(fixture, 'project_open', { path: `/tmp/zzz_nonexistent_${randomUUID()}` }),
			'a missing path'
		);
		assert.equal(error.code, -32003);
		assert.deepEqual(error.data, { reason: 'path_not_found' });
		assert.ok(
			error.message.startsWith("failed to open project: the path can't be resolved:"),
			`unexpected message: ${error.message}`
		);
	});

	test('project_close', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('close');
		const root = await open_project(fixture, tmp_dir);

		const close = await call(fixture, 'project_close', { root });
		const closed = result_of(close, 'close') as { rev: number };
		assert.deepEqual(Object.keys(closed), ['rev'], 'the close answers its rev alone');
		assert.ok(Number.isSafeInteger(closed.rev) && closed.rev > 0, `rev: ${closed.rev}`);
		assert.notInclude(await list_roots(fixture), root, 'project gone');

		const error = error_of(await call(fixture, 'project_close', { root }), 'a double close');
		assert.equal(error.code, -32602);
		assert.ok(
			error.message.startsWith('project not open:'),
			`unexpected message: ${error.message}`
		);
		assert.deepEqual(error.data, { reason: ERROR_PROJECT_NOT_OPEN });
	});

	test('project_changed_on_open', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		const tmp_dir = await create_tmp_project('changed_open');
		try {
			// Warm-up ping to ensure the connection is registered.
			await ws.request('_warmup', 'ping', undefined);
			await open_project(fixture, tmp_dir);

			const notification = await ws.wait_for<Record<string, unknown>>(
				is_notification('project_changed'),
				5_000
			);
			const params = notification.params as Record<string, unknown>;
			assert.equal(params.type, 'open');
			const project = params.project as Record<string, unknown>;
			assert.equal(project.root, `${tmp_dir}/`);
			assert.equal(typeof project.name, 'string');
			assert.equal(typeof project.opened_at, 'string');
		} finally {
			await ws.close();
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_changed_on_close', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('changed_close');
		const root = await open_project(fixture, tmp_dir);
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);
			await close_project(fixture, root);

			const notification = await ws.wait_for<Record<string, unknown>>(
				is_notification('project_changed'),
				5_000
			);
			const params = notification.params as Record<string, unknown>;
			assert.equal(params.type, 'close');
			assert.equal((params.project as Record<string, unknown>).root, root, 'same root');
		} finally {
			await ws.close();
		}
	});

	test('project_changed_idempotent_no_notification', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('changed_idempotent');
		try {
			await open_project(fixture, tmp_dir);
			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies()
			});
			try {
				await ws.request('_warmup', 'ping', undefined);
				// the same project opened again: nothing changed, so no broadcast
				await open_project(fixture, tmp_dir);

				let saw_project_changed = false;
				try {
					await ws.wait_for(is_notification('project_changed'), 500);
					saw_project_changed = true;
				} catch {
					// expected timeout
				}
				assert.ok(!saw_project_changed, 'an idempotent open must not notify');
			} finally {
				await ws.close();
			}
		} finally {
			await call(fixture, 'project_close', { root: `${tmp_dir}/` }).catch(() => undefined);
		}
	});

	test('project_close_on_zzz_dir_keeps_write_access', async () => {
		const fixture = await setup_test();
		await mkdir(zzz_dir, { recursive: true });
		const root = await open_project(fixture, zzz_dir);
		await close_project(fixture, root);
		await assert_writable(fixture, join(zzz_dir, `after_close_${randomUUID()}.txt`));
	});

	test('project_close_on_scoped_dir_keeps_write_access', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, { recursive: true });
		// a non-canonical spelling opens and closes the canonical project
		const spelled = `${scoped_dir}/./`;
		const root = await open_project(fixture, spelled);
		assert.ok(!root.endsWith('/./'), `root is canonical: ${root}`);
		await close_project(fixture, spelled);
		assert.notInclude(await list_roots(fixture), root, 'project closed');

		await assert_writable(fixture, join(scoped_dir, `after_close_${randomUUID()}.txt`));
	});

	test('project_close_nested_in_scoped_dir_keeps_write_access', async () => {
		const fixture = await setup_test();
		const nested = join(scoped_dir, `nested_project_${randomUUID()}`);
		await mkdir(nested, { recursive: true });
		try {
			const root = await open_project(fixture, nested);
			await close_project(fixture, root);
			await assert_writable(fixture, join(nested, 'after_close.txt'));
		} finally {
			await remove_dir(nested);
		}
	});

	test('project_close_revokes_its_own_scope', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('revoke');
		const root = await open_project(fixture, tmp_dir);
		await assert_writable(fixture, join(tmp_dir, 'while_open.txt'));
		await close_project(fixture, root);
		await assert_not_writable(fixture, join(tmp_dir, 'after_close.txt'));
	});

	test('testing_reset_closes_projects_and_restores_scope', async () => {
		const fixture = await setup_test();
		const tmp_dir = await create_tmp_project('reset');
		// left open on purpose — the next reset must release it
		await open_project(fixture, tmp_dir);
		await open_project(fixture, zzz_dir);
		await assert_writable(fixture, join(tmp_dir, 'while_open.txt'));

		const after_reset = await setup_test();
		assert.deepEqual(await list_roots(after_reset), [], 'reset closes every project');

		await assert_not_writable(after_reset, join(tmp_dir, 'after_reset.txt'));
		await assert_writable(after_reset, join(zzz_dir, `after_reset_${randomUUID()}.txt`));
		await assert_writable(after_reset, join(scoped_dir, `after_reset_${randomUUID()}.txt`));
	});

	test('project_open_and_close_reject_non_absolute_paths', async () => {
		const fixture = await setup_test();
		for (const [method, key] of [
			['project_open', 'path'],
			['project_close', 'root']
		] as const) {
			for (const path of ['', '.', 'relative/dir', '~/dev']) {
				const res = await call(fixture, method, { [key]: path });
				assert.ok(!res.ok, `${method} should reject ${JSON.stringify(path)}`);
				assert.equal(res.error.code, -32602, `${method} ${JSON.stringify(path)}`);
			}
		}
	});
});

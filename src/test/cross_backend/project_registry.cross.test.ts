/**
 * Cross-backend tests for opening a registry project — a `repos.toml` the
 * way `~/dev` holds one — against a backend whose `HOME` is a fixture
 * directory (`rust_projects_backend_config`), since the walk for a registry
 * stops below the home directory and trusts nothing a temp root's other
 * users could write.
 *
 * Pins what `project_open` resolves (the root, its kind, every entry's
 * state), what it indexes (the root's loose files and the focused repo —
 * never an unfocused repo or an unregistered directory), the focus an open
 * adds to an open project (`project_changed` `update`), the focus an open
 * requests and what of it it refuses, what `repo_focus` and
 * `repo_unfocus` index and release and what they refuse, what `repo_files`
 * reads for a client pulling another's focus and what it refuses, the
 * lifecycle rev each change stamps and every reply and notification carries,
 * the refusal of an untrusted registry with its reason, the fallback past a
 * registry for a path in none of its entries or under a refused registry in
 * a checkout (`fallback`, on the reply and `project_changed`), what git
 * ignores under a focused checkout (`ignored`, on the reply and refreshed by
 * a `.gitignore` edit), and the scope a close releases.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, test, assert, onTestFinished } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import {
	is_notification,
	is_notification_with
} from '@fuzdev/fuz_app/testing/transports/ws_client.ts';

import {
	ProjectChangedInput,
	ProjectCloseOutput,
	ProjectOpenOutput,
	RepoFilesOutput,
	RepoFocusOutput,
	RepoUnfocusOutput
} from '#lib/action_specs.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

type CrossFixture = Awaited<ReturnType<typeof setup_test>>;

const home = handle.config.env.HOME!;

const call = (fixture: CrossFixture, method: string, params?: Record<string, unknown>) =>
	rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method,
		params,
		headers: fixture.create_session_headers()
	});

/** `project_open`'s result, parsed by its TS schema. */
const open_project = async (
	fixture: CrossFixture,
	path: string,
	focus?: Array<string>
): Promise<ProjectOpenOutput> => {
	const res = await call(fixture, 'project_open', focus ? { path, focus } : { path });
	assert.ok(res.ok, `project_open failed: ${JSON.stringify(res)}`);
	const parsed = parse(ProjectOpenOutput, res.result);
	assert.ok(parsed.ok, `project_open result: ${JSON.stringify(parsed)}`);
	return parsed.value;
};

const REGISTRY = `owners = ["me"]

[repos.app]
url = "https://github.com/me/app"
visibility = "public"
purpose = "an app"

[repos.site]
url = "https://github.com/me/site"
visibility = "private"
purpose = "a site, not yet cloned"

[references.escape]
url = "https://github.com/them/escape"
purpose = "a reference whose dir links out of the root"
`;

/**
 * A registry root under the fixture home, every mode set (a umask may leave
 * them group-writable, which the trust rule refuses): the registry, a loose
 * file, the `app` repo with nested files, no `site`, an `escape` entry
 * linking outside the root, and an unregistered `scratch` directory.
 * Removed once the test finishes.
 */
const create_registry_root = async (): Promise<{ dev: string; outside: string }> => {
	const dev = join(home, `dev_${randomUUID()}`);
	const outside = join(home, `outside_${randomUUID()}`);
	onTestFinished(async () => {
		await chmod(dev, 0o755).catch(() => undefined);
		await rm(dev, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});
	for (const dir of [
		dev,
		join(dev, 'app'),
		join(dev, 'app', 'src'),
		join(dev, 'scratch'),
		outside
	]) {
		await mkdir(dir, { recursive: true });
		await chmod(dir, 0o755);
	}
	for (const [path, text] of [
		[join(dev, 'repos.toml'), REGISTRY],
		[join(dev, 'README.md'), 'loose'],
		[join(dev, 'app', 'a.ts'), 'a'],
		[join(dev, 'app', 'src', 'b.ts'), 'b'],
		[join(dev, 'scratch', 'x.txt'), 'x']
	] as const) {
		await writeFile(path, text, 'utf-8');
		await chmod(path, 0o644);
	}
	await symlink(outside, join(dev, 'escape'));
	return { dev, outside };
};

const file_ids = (output: ProjectOpenOutput): Array<string> =>
	output.files.map((f) => f.id as string).sort();

describe('project registry cross-backend', () => {
	test('opening a path in a repo opens the registry root, focused on that repo', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const opened = await open_project(fixture, join(dev, 'app', 'src', 'b.ts'));
		const { project } = opened;
		assert.strictEqual(project.root, `${dev}/`);
		assert.strictEqual(project.kind, 'registry');
		assert.strictEqual(project.registry_path, join(dev, 'repos.toml'));
		assert.deepEqual(project.entries, [
			{ key: 'app', kind: 'repo', dir: `${dev}/app/`, state: 'present' },
			{ key: 'site', kind: 'repo', dir: `${dev}/site/`, state: 'missing' },
			{
				key: 'escape',
				kind: 'reference',
				dir: `${dev}/escape/`,
				state: 'refused',
				reason: 'entry_not_confined'
			}
		] as typeof project.entries);
		assert.deepEqual(project.focused, [`${dev}/app/`]);
		assert.strictEqual(opened.focus, `${dev}/app/`);
		// the root's loose files and the focused repo — not the registry's
		// unregistered `scratch`, nothing through `escape`
		assert.deepEqual(file_ids(opened), [
			join(dev, 'README.md'),
			join(dev, 'app', 'a.ts'),
			join(dev, 'app', 'src', 'b.ts'),
			join(dev, 'repos.toml')
		]);
	});

	test('an open of the root lands the focus it requests and refuses the rest per dir', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		// a reopen's shape: the root, with every focus it held requested
		const opened = await open_project(fixture, dev, [
			`${dev}/app/`,
			`${dev}/site/`,
			join(dev, 'escape'),
			`${dev}/scratch/`
		]);
		assert.strictEqual(opened.project.root, `${dev}/`);
		assert.strictEqual(opened.focus, null);
		assert.deepEqual(opened.project.focused, [`${dev}/app/`]);
		assert.deepEqual(opened.refused, [
			{ dir: `${dev}/site/`, reason: 'repo_not_present' },
			{ dir: `${dev}/escape/`, reason: 'repo_not_present' },
			{ dir: `${dev}/scratch/`, reason: 'repo_not_in_project' }
		]);
		// every filer the open keeps: the root's loose files and the focused repo
		assert.deepEqual(file_ids(opened), [
			join(dev, 'README.md'),
			join(dev, 'app', 'a.ts'),
			join(dev, 'app', 'src', 'b.ts'),
			join(dev, 'repos.toml')
		]);
	});

	test('the root alone focuses nothing; opening a repo adds its focus and notifies', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const at_root = await open_project(fixture, dev);
		assert.strictEqual(at_root.focus, null);
		assert.deepEqual(at_root.project.focused, []);
		assert.deepEqual(file_ids(at_root), [join(dev, 'README.md'), join(dev, 'repos.toml')]);

		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);
			const in_app = await open_project(fixture, join(dev, 'app'));
			assert.strictEqual(in_app.project.opened_at, at_root.project.opened_at, 'the same project');
			assert.deepEqual(in_app.project.focused, [`${dev}/app/`]);
			assert.include(file_ids(in_app), join(dev, 'app', 'src', 'b.ts'));

			const notification = await ws.wait_for<Record<string, unknown>>(
				is_notification('project_changed'),
				5_000
			);
			const params = parse(ProjectChangedInput, notification.params);
			assert.ok(params.ok, JSON.stringify(params));
			assert.strictEqual(params.value.type, 'update');
			assert.deepEqual(params.value.project.focused, [`${dev}/app/`]);
		} finally {
			await ws.close();
		}
	});

	test('focusing an entry indexes it; unfocusing it drops its files for every client', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const root = `${dev}/`;
		const app_dir = `${dev}/app/`;
		await open_project(fixture, dev);

		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		/** The next `project_changed` `update` reporting `focused`. */
		const update_with = (focused: Array<string>) =>
			ws.wait_for<Record<string, unknown>>(
				is_notification_with<{ type: string; project: { focused: Array<string> } }>(
					'project_changed',
					(params) =>
						params.type === 'update' &&
						JSON.stringify(params.project.focused) === JSON.stringify(focused)
				),
				5_000
			);
		try {
			await ws.request('_warmup', 'ping', undefined);
			const focused_update = update_with([app_dir]);
			const res = await call(fixture, 'repo_focus', { root, dir: app_dir });
			assert.ok(res.ok, `repo_focus failed: ${JSON.stringify(res)}`);
			const focused = parse(RepoFocusOutput, res.result);
			assert.ok(focused.ok, JSON.stringify(focused));
			assert.deepEqual(focused.value.project.focused, [app_dir]);
			assert.deepEqual(
				focused.value.files.map((f) => f.id as string).sort(),
				[join(dev, 'app', 'a.ts'), join(dev, 'app', 'src', 'b.ts')],
				"the focused repo alone — the root's loose files are the client's already"
			);
			const notification = parse(ProjectChangedInput, (await focused_update).params);
			assert.ok(notification.ok, JSON.stringify(notification));

			// another client, told of the focus, pulls the repo over its socket
			const pulled = parse(
				RepoFilesOutput,
				await ws.request('pull', 'repo_files', { root, dir: app_dir })
			);
			assert.ok(pulled.ok, JSON.stringify(pulled));
			assert.deepEqual(pulled.value.files.map((f) => f.id as string).sort(), [
				join(dev, 'app', 'a.ts'),
				join(dev, 'app', 'src', 'b.ts')
			]);

			// again: the same focus, a trailing slash optional
			const again = await call(fixture, 'repo_focus', { root: dev, dir: join(dev, 'app') });
			assert.ok(again.ok, `repo_focus failed: ${JSON.stringify(again)}`);
			assert.deepEqual((again.result as RepoFocusOutput).project.focused, [app_dir]);

			const unfocused_update = update_with([]);
			const unfocus = await call(fixture, 'repo_unfocus', { root, dir: app_dir });
			assert.ok(unfocus.ok, `repo_unfocus failed: ${JSON.stringify(unfocus)}`);
			const unfocused = parse(RepoUnfocusOutput, unfocus.result);
			assert.ok(unfocused.ok, JSON.stringify(unfocused));
			assert.deepEqual(unfocused.value.project.focused, []);
			await unfocused_update;
			// a pull after the unfocus is refused, not answered empty
			const late = await call(fixture, 'repo_files', { root, dir: app_dir });
			assert.ok(!late.ok);
			assert.deepEqual(late.error.data, { reason: 'repo_not_focused' });

			// another client's snapshot no longer has the repo's files
			const session = await ws.request<{ data: { files: Array<{ id: string }> } }>(
				'snapshot',
				'session_load',
				undefined
			);
			const ids = session.data.files.map((f) => f.id);
			assert.include(ids, join(dev, 'README.md'));
			assert.notInclude(ids, join(dev, 'app', 'a.ts'));
			assert.notInclude(ids, join(dev, 'app', 'src', 'b.ts'));
		} finally {
			await ws.close();
		}
	});

	test('each change stamps a newer rev, which its reply and notification carry', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const root = `${dev}/`;
		const app_dir = `${dev}/app/`;
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		/**
		 * The rev of the `project_changed` of `type` for this root reporting
		 * `focused` — the client matches over every message it has received.
		 */
		const changed = (type: string, focused: Array<string>) =>
			ws
				.wait_for<Record<string, unknown>>(
					is_notification_with<{
						type: string;
						project: { root: string; focused: Array<string> };
					}>(
						'project_changed',
						(params) =>
							params.type === type &&
							params.project.root === root &&
							JSON.stringify(params.project.focused) === JSON.stringify(focused)
					),
					5_000
				)
				.then((n) => {
					const parsed = parse(ProjectChangedInput, n.params);
					assert.ok(parsed.ok, JSON.stringify(parsed));
					return parsed.value.project.rev;
				});
		let snapshots = 0;
		const session_rev = async (): Promise<number> => {
			// each request its own id: the client matches replies by id
			const session = await ws.request<{ data: { projects_rev: number } }>(
				`snapshot_${snapshots++}`,
				'session_load',
				undefined
			);
			return session.data.projects_rev;
		};
		try {
			await ws.request('_warmup', 'ping', undefined);
			const before = await session_rev();

			const opened_notification = changed('open', []);
			const opened = await open_project(fixture, dev);
			assert.isTrue(opened.opened, 'this open created it');
			assert.isAbove(opened.project.rev, before);
			assert.strictEqual(await opened_notification, opened.project.rev);
			assert.strictEqual(await session_rev(), opened.project.rev, 'nothing changed since');

			// an open that changes nothing merges, at the same rev
			const again = await open_project(fixture, dev);
			assert.isFalse(again.opened, 'merged into the open project');
			assert.strictEqual(again.project.rev, opened.project.rev);

			const focused_notification = changed('update', [app_dir]);
			const focus = await call(fixture, 'repo_focus', { root, dir: app_dir });
			assert.ok(focus.ok, JSON.stringify(focus));
			const focused = parse(RepoFocusOutput, focus.result);
			assert.ok(focused.ok, JSON.stringify(focused));
			assert.isAbove(focused.value.project.rev, opened.project.rev);
			assert.strictEqual(await focused_notification, focused.value.project.rev);

			const pulled = parse(
				RepoFilesOutput,
				await ws.request('pull', 'repo_files', { root, dir: app_dir })
			);
			assert.ok(pulled.ok, JSON.stringify(pulled));
			assert.strictEqual(pulled.value.rev, focused.value.project.rev, 'read at the focus');

			const unfocused_notification = changed('update', []);
			const unfocus = await call(fixture, 'repo_unfocus', { root, dir: app_dir });
			assert.ok(unfocus.ok, JSON.stringify(unfocus));
			const unfocused = parse(RepoUnfocusOutput, unfocus.result);
			assert.ok(unfocused.ok, JSON.stringify(unfocused));
			assert.isAbove(unfocused.value.project.rev, focused.value.project.rev);
			assert.strictEqual(await unfocused_notification, unfocused.value.project.rev);

			const closed_notification = changed('close', []);
			const close = await call(fixture, 'project_close', { root });
			assert.ok(close.ok, JSON.stringify(close));
			const closed = parse(ProjectCloseOutput, close.result);
			assert.ok(closed.ok, JSON.stringify(closed));
			assert.isAbove(closed.value.rev, unfocused.value.project.rev);
			assert.strictEqual(await closed_notification, closed.value.rev);
			assert.strictEqual(await session_rev(), closed.value.rev, 'the snapshot is at the close');

			// opened again: a newer rev, created again
			const reopened = await open_project(fixture, dev);
			assert.isTrue(reopened.opened);
			assert.isAbove(reopened.project.rev, closed.value.rev);
		} finally {
			await ws.close();
		}
	});

	test('repo_focus and repo_unfocus refuse what isn’t a present entry, naming why', async () => {
		const fixture = await setup_test();
		const { dev, outside } = await create_registry_root();
		const root = `${dev}/`;
		await open_project(fixture, dev);
		await open_project(fixture, outside);

		const refused = async (
			method: string,
			params: Record<string, unknown>,
			code: number,
			reason: string
		): Promise<void> => {
			const res = await call(fixture, method, params);
			assert.ok(!res.ok, `${method} ${JSON.stringify(params)} should be refused`);
			assert.strictEqual(res.error.code, code, JSON.stringify(res.error));
			assert.deepEqual(res.error.data, { reason }, JSON.stringify(res.error));
		};
		await refused(
			'repo_focus',
			{ root: `${dev}_none/`, dir: `${dev}/app/` },
			-32602,
			'project_not_open'
		);
		await refused('repo_focus', { root, dir: `${dev}/scratch/` }, -32602, 'repo_not_in_project');
		await refused('repo_focus', { root, dir: `${dev}/site/` }, -32003, 'repo_not_present');
		await refused('repo_focus', { root, dir: `${dev}/escape/` }, -32002, 'repo_not_present');
		await refused(
			'repo_unfocus',
			{ root: `${outside}/`, dir: `${outside}/` },
			-32602,
			'project_not_registry'
		);
		await refused('repo_unfocus', { root, dir: `${dev}/scratch/` }, -32602, 'repo_not_in_project');
		await refused(
			'repo_files',
			{ root: `${dev}_none/`, dir: `${dev}/app/` },
			-32602,
			'project_not_open'
		);
		// a present entry not focused, the root itself, and what's no entry
		for (const dir of [`${dev}/app/`, root, `${dev}/scratch/`]) {
			await refused('repo_files', { root, dir }, -32602, 'repo_not_focused');
		}

		const list = await call(fixture, 'project_list');
		assert.ok(list.ok);
		const projects = (list.result as { projects: Array<{ root: string; focused: Array<string> }> })
			.projects;
		assert.deepEqual(projects.find((p) => p.root === root)?.focused, [], 'nothing focused');
	});

	test('the whole root is in scope while open, and out of it once closed', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		await open_project(fixture, join(dev, 'app'));
		// an unfocused, unregistered directory is still the project's to write
		const scratch_file = join(dev, 'scratch', 'written.txt');
		const write = await call(fixture, 'diskfile_update', { path: scratch_file, content: 'in' });
		assert.ok(write.ok, `diskfile_update failed: ${JSON.stringify(write)}`);

		const close = await call(fixture, 'project_close', { root: `${dev}/` });
		assert.ok(close.ok, `project_close failed: ${JSON.stringify(close)}`);
		const after = await call(fixture, 'diskfile_update', { path: scratch_file, content: 'out' });
		assert.ok(!after.ok, 'out of scope once closed');
		const list = await call(fixture, 'project_list');
		assert.ok(list.ok);
		assert.deepEqual((list.result as Record<string, unknown>).projects, []);
	});

	test('a registry others can write refuses the open, naming why', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		await chmod(dev, 0o777);
		const res = await call(fixture, 'project_open', { path: join(dev, 'app') });
		assert.ok(!res.ok, 'expected an untrusted registry to be refused');
		assert.strictEqual(res.error.code, -32002);
		assert.deepEqual(res.error.data, { reason: 'registry_untrusted' });
		assert.ok(res.error.message.startsWith('failed to open project: '), res.error.message);
		const list = await call(fixture, 'project_list');
		assert.ok(list.ok);
		assert.deepEqual((list.result as Record<string, unknown>).projects, [], 'nothing opened');
	});

	test('a path in no entry opens as its directory, saying which registry passed it over', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);
			const opened = await open_project(fixture, join(dev, 'scratch', 'x.txt'));
			const fallback = { kind: 'unregistered', registry_path: join(dev, 'repos.toml') };
			assert.strictEqual(opened.project.root, `${dev}/scratch/`);
			assert.strictEqual(opened.project.kind, 'plain_dir');
			assert.deepEqual(opened.project.fallback, fallback as typeof opened.project.fallback);
			assert.deepEqual(file_ids(opened), [join(dev, 'scratch', 'x.txt')]);

			const notification = await ws.wait_for<Record<string, unknown>>(
				is_notification('project_changed'),
				5_000
			);
			const params = parse(ProjectChangedInput, notification.params);
			assert.ok(params.ok, JSON.stringify(params));
			assert.strictEqual(params.value.type, 'open');
			assert.deepEqual(params.value.project.fallback, opened.project.fallback);
		} finally {
			await ws.close();
		}
	});

	test('an invalid registry in a checkout opens the checkout, naming why', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const tool = join(dev, 'tool');
		for (const dir of [tool, join(tool, '.git'), join(tool, 'src')]) {
			await mkdir(dir);
			await chmod(dir, 0o755);
		}
		for (const [path, text] of [
			[join(tool, 'repos.toml'), 'this is not [[ toml'],
			[join(tool, 'src', 'c.ts'), 'c']
		] as const) {
			await writeFile(path, text, 'utf-8');
			await chmod(path, 0o644);
		}
		const opened = await open_project(fixture, join(tool, 'src'));
		assert.strictEqual(opened.project.root, `${tool}/`);
		assert.strictEqual(opened.project.kind, 'git_repo');
		assert.deepEqual(opened.project.fallback, {
			kind: 'registry_refused',
			registry_path: join(tool, 'repos.toml'),
			reason: 'registry_invalid'
		} as typeof opened.project.fallback);
		assert.deepEqual(file_ids(opened), [join(tool, 'repos.toml'), join(tool, 'src', 'c.ts')]);
	});

	test('a checkout holding its own registry, nothing cloned, opens as the checkout from its root too', async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const tool = join(dev, 'tool');
		for (const dir of [tool, join(tool, '.git'), join(tool, 'src')]) {
			await mkdir(dir);
			await chmod(dir, 0o755);
		}
		for (const [path, text] of [
			[join(tool, 'repos.toml'), REGISTRY],
			[join(tool, 'src', 'c.ts'), 'c']
		] as const) {
			await writeFile(path, text, 'utf-8');
			await chmod(path, 0o644);
		}
		const fallback = { kind: 'unregistered', registry_path: join(tool, 'repos.toml') };
		const from_src = await open_project(fixture, join(tool, 'src'));
		assert.strictEqual(from_src.project.root, `${tool}/`);
		assert.strictEqual(from_src.project.kind, 'git_repo');
		assert.deepEqual(from_src.project.fallback, fallback as typeof from_src.project.fallback);
		// a restart's reopen: the root, its one focus requested — the same kind
		const reopened = await open_project(fixture, tool, [`${tool}/`]);
		assert.strictEqual(reopened.project.root, `${tool}/`);
		assert.strictEqual(reopened.project.kind, 'git_repo');
		assert.deepEqual(reopened.project.fallback, fallback as typeof reopened.project.fallback);
		assert.deepEqual(reopened.project.focused, [`${tool}/`]);
		assert.deepEqual(reopened.refused, []);
	});

	test("a focused checkout carries git's ignored paths, refreshed by a .gitignore edit", async () => {
		const fixture = await setup_test();
		const { dev } = await create_registry_root();
		const app_dir = `${dev}/app/`;
		await promisify(execFile)('git', ['init', '-q'], { cwd: join(dev, 'app') });
		for (const [path, text] of [
			[join(dev, 'app', '.gitignore'), '*.log\n'],
			[join(dev, 'app', 'x.log'), 'x']
		] as const) {
			await writeFile(path, text, 'utf-8');
			await chmod(path, 0o644);
		}
		const opened = await open_project(fixture, join(dev, 'app', 'a.ts'));
		assert.deepEqual(opened.project.focused, [app_dir]);
		assert.deepEqual(Object.keys(opened.project.ignored), [app_dir], 'the root has no entry');
		const ignored = opened.project.ignored[app_dir]!;
		assert.include(ignored.paths, 'x.log');
		assert.strictEqual(ignored.resyncs, 0);
		assert.notInclude(file_ids(opened), join(dev, 'app', 'x.log'));

		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);
			const refreshed = ws.wait_for<Record<string, unknown>>(
				is_notification_with<{
					type: string;
					project: { ignored: Record<string, { paths: Array<string> }> };
				}>(
					'project_changed',
					(params) =>
						params.type === 'update' &&
						(params.project.ignored[app_dir]?.paths.includes('src/b.ts') ?? false)
				),
				10_000
			);
			await writeFile(join(dev, 'app', '.gitignore'), 'src/b.ts\n', 'utf-8');
			const notification = parse(ProjectChangedInput, (await refreshed).params);
			assert.ok(notification.ok, JSON.stringify(notification));
			const { project } = notification.value;
			assert.ok(project.rev > opened.project.rev, 'a newer rev');
			assert.notInclude(project.ignored[app_dir]!.paths, 'x.log');
			// a reply after it carries the new set too
			const again = await open_project(fixture, join(dev, 'app'));
			assert.include(again.project.ignored[app_dir]!.paths, 'src/b.ts');
			assert.include(file_ids(again), join(dev, 'app', 'x.log'));
			assert.notInclude(file_ids(again), join(dev, 'app', 'src', 'b.ts'));
		} finally {
			await ws.close();
		}
	});
});

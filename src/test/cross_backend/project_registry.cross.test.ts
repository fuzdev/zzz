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
 * adds to an open project (`project_changed` `update`), the refusal of an
 * untrusted registry with its reason, and the scope a close releases.
 *
 * @module
 */

import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, test, assert, onTestFinished } from 'vitest';
import { parse } from '@fuzdev/fuz_schema/schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { is_notification } from '@fuzdev/fuz_app/testing/transports/ws_client.ts';

import { ProjectChangedInput, ProjectOpenOutput } from '#lib/action_specs.ts';

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
const open_project = async (fixture: CrossFixture, path: string): Promise<ProjectOpenOutput> => {
	const res = await call(fixture, 'project_open', { path });
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
});

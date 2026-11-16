// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Project } from '#lib/project.svelte.ts';
import { Projects } from '#lib/projects.svelte.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('Project', () => {
	test('initializes with path and defaults', () => {
		const path = parse_or_throw(DiskfileDirectoryPath, '/some/dir/');
		const project = new Project({ app, json: { root: path } });

		assert.isDefined(project.id);
		assert.strictEqual(project.root, path);
		assert.strictEqual(project.name, '');
		assert.strictEqual(project.opened_at, '');
	});

	test('initializes with provided json', () => {
		const path = parse_or_throw(DiskfileDirectoryPath, '/home/user/project/');
		const project = new Project({
			app,
			json: {
				root: path,
				name: 'project',
				opened_at: '2026-04-08T00:00:00.000Z'
			}
		});

		assert.strictEqual(project.root, path);
		assert.strictEqual(project.name, 'project');
		assert.strictEqual(project.opened_at, '2026-04-08T00:00:00.000Z');
	});

	test('defaults to a plain directory with nothing focused', () => {
		const root = parse_or_throw(DiskfileDirectoryPath, '/some/dir/');
		const project = new Project({ app, json: { root } });
		assert.strictEqual(project.kind, 'plain_dir');
		assert.strictEqual(project.registry_path, null);
		assert.deepEqual(project.entries, []);
		assert.deepEqual(project.focused, []);
		assert.strictEqual(project.watch_status, 'full');
	});

	test('a reopen opens each focused directory, or the root when none is', () => {
		const root = parse_or_throw(DiskfileDirectoryPath, '/dev/');
		const a = parse_or_throw(DiskfileDirectoryPath, '/dev/a/');
		const b = parse_or_throw(DiskfileDirectoryPath, '/dev/b/');
		const project = new Project({ app, json: { root, kind: 'registry', focused: [a, b] } });
		assert.deepEqual(project.reopen_paths, [a, b]);
		project.focused = [];
		assert.deepEqual(project.reopen_paths, [root]);
	});

	test('registers in cell registry', () => {
		const path = parse_or_throw(DiskfileDirectoryPath, '/some/dir/');
		const project = new Project({ app, json: { root: path } });
		assert.ok(app.cell_registry.all.has(project.id));
	});

	test('serializes to json', () => {
		const path = parse_or_throw(DiskfileDirectoryPath, '/some/dir/');
		const project = new Project({
			app,
			json: { root: path, name: 'dir', opened_at: '2026-01-01T00:00:00.000Z' }
		});

		const json = project.json;
		assert.strictEqual(json.root, path);
		assert.strictEqual(json.name, 'dir');
		assert.strictEqual(json.opened_at, '2026-01-01T00:00:00.000Z');
	});
});

describe('Projects', () => {
	test('initializes empty', () => {
		const projects = new Projects({ app });

		assert.strictEqual(projects.items.by_id.size, 0);
		assert.strictEqual(projects.active_id, null);
		assert.strictEqual(projects.active, undefined);
	});

	test('add creates a project and auto-activates first', () => {
		const projects = new Projects({ app });
		const path = parse_or_throw(DiskfileDirectoryPath, '/home/user/project/');

		const project = projects.add({
			root: path,
			name: 'project',
			opened_at: '2026-01-01T00:00:00.000Z'
		});

		assert.strictEqual(projects.items.by_id.size, 1);
		assert.strictEqual(projects.active_id, project.id);
		assert.strictEqual(projects.active, project);
	});

	test('add deduplicates by root, taking the newer state', () => {
		const projects = new Projects({ app });
		const path = parse_or_throw(DiskfileDirectoryPath, '/home/user/project/');

		const first = projects.add({
			root: path,
			name: 'project',
			opened_at: '2026-01-01T00:00:00.000Z'
		});
		const second = projects.add({
			root: path,
			name: 'project',
			opened_at: '2026-02-01T00:00:00.000Z'
		});

		assert.strictEqual(first, second);
		assert.strictEqual(projects.items.by_id.size, 1);
		assert.strictEqual(first.opened_at, '2026-02-01T00:00:00.000Z');
	});

	test('add multiple projects', () => {
		const projects = new Projects({ app });
		const path_a = parse_or_throw(DiskfileDirectoryPath, '/path/a/');
		const path_b = parse_or_throw(DiskfileDirectoryPath, '/path/b/');

		const a = projects.add({ root: path_a, name: 'a', opened_at: '' });
		const b = projects.add({ root: path_b, name: 'b', opened_at: '' });

		assert.strictEqual(projects.items.by_id.size, 2);
		// First added is auto-activated
		assert.strictEqual(projects.active_id, a.id);
		assert.notStrictEqual(a.id, b.id);
	});

	test('remove deletes project and updates active_id', () => {
		const projects = new Projects({ app });
		const path_a = parse_or_throw(DiskfileDirectoryPath, '/path/a/');
		const path_b = parse_or_throw(DiskfileDirectoryPath, '/path/b/');

		const a = projects.add({ root: path_a, name: 'a', opened_at: '' });
		projects.add({ root: path_b, name: 'b', opened_at: '' });

		assert.strictEqual(projects.active_id, a.id);

		projects.remove(a.id);

		assert.strictEqual(projects.items.by_id.size, 1);
		// active_id should move to remaining project
		assert.notStrictEqual(projects.active_id, null);
		assert.notStrictEqual(projects.active_id, a.id);
	});

	test('remove last project sets active_id to null', () => {
		const projects = new Projects({ app });
		const path = parse_or_throw(DiskfileDirectoryPath, '/path/only/');

		const only = projects.add({ root: path, name: 'only', opened_at: '' });
		projects.remove(only.id);

		assert.strictEqual(projects.items.by_id.size, 0);
		assert.strictEqual(projects.active_id, null);
	});

	test('get_by_root returns project or undefined', () => {
		const projects = new Projects({ app });
		const path = parse_or_throw(DiskfileDirectoryPath, '/home/user/project/');

		assert.strictEqual(projects.get_by_root(path), undefined);

		const project = projects.add({ root: path, name: 'project', opened_at: '' });
		assert.strictEqual(projects.get_by_root(path), project);
	});

	test('activate changes active project', () => {
		const projects = new Projects({ app });
		const path_a = parse_or_throw(DiskfileDirectoryPath, '/path/a/');
		const path_b = parse_or_throw(DiskfileDirectoryPath, '/path/b/');

		const a = projects.add({ root: path_a, name: 'a', opened_at: '' });
		const b = projects.add({ root: path_b, name: 'b', opened_at: '' });

		assert.strictEqual(projects.active_id, a.id);

		projects.activate(b.id);
		assert.strictEqual(projects.active_id, b.id);
		assert.strictEqual(projects.active, b);
	});

	test('activate with unknown id is a no-op', () => {
		const projects = new Projects({ app });
		const path = parse_or_throw(DiskfileDirectoryPath, '/path/a/');

		const a = projects.add({ root: path, name: 'a', opened_at: '' });
		projects.activate('nonexistent-id' as Uuid);

		assert.strictEqual(projects.active_id, a.id);
	});

	test('initializes from json with items', () => {
		const path_a = parse_or_throw(DiskfileDirectoryPath, '/path/a/');
		const path_b = parse_or_throw(DiskfileDirectoryPath, '/path/b/');

		const projects = new Projects({
			app,
			json: {
				items: [
					{ root: path_a, name: 'a', opened_at: '2026-01-01T00:00:00.000Z' },
					{ root: path_b, name: 'b', opened_at: '2026-02-01T00:00:00.000Z' }
				]
			}
		});

		assert.strictEqual(projects.items.by_id.size, 2);
		assert.isDefined(projects.get_by_root(path_a));
		assert.isDefined(projects.get_by_root(path_b));
	});
});

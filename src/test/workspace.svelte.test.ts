// @vitest-environment jsdom

import {test, beforeEach, describe, assert} from 'vitest';

import {Workspace} from '$lib/workspace.svelte.js';
import {Workspaces} from '$lib/workspaces.svelte.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {DiskfileDirectoryPath} from '$lib/diskfile_types.js';
import type {Uuid} from '$lib/zod_helpers.js';
import {monkeypatch_zzz_for_tests} from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('Workspace', () => {
	test('initializes with path and defaults', () => {
		const path = DiskfileDirectoryPath.parse('/some/dir/');
		const workspace = new Workspace({app, json: {path}});

		assert.isDefined(workspace.id);
		assert.strictEqual(workspace.path, path);
		assert.strictEqual(workspace.name, '');
		assert.strictEqual(workspace.opened_at, '');
	});

	test('initializes with provided json', () => {
		const path = DiskfileDirectoryPath.parse('/home/user/project/');
		const workspace = new Workspace({
			app,
			json: {
				path,
				name: 'project',
				opened_at: '2026-04-08T00:00:00.000Z',
			},
		});

		assert.strictEqual(workspace.path, path);
		assert.strictEqual(workspace.name, 'project');
		assert.strictEqual(workspace.opened_at, '2026-04-08T00:00:00.000Z');
	});

	test('registers in cell registry', () => {
		const path = DiskfileDirectoryPath.parse('/some/dir/');
		const workspace = new Workspace({app, json: {path}});
		assert.ok(app.cell_registry.all.has(workspace.id));
	});

	test('serializes to json', () => {
		const path = DiskfileDirectoryPath.parse('/some/dir/');
		const workspace = new Workspace({
			app,
			json: {path, name: 'dir', opened_at: '2026-01-01T00:00:00.000Z'},
		});

		const json = workspace.json;
		assert.strictEqual(json.path, path);
		assert.strictEqual(json.name, 'dir');
		assert.strictEqual(json.opened_at, '2026-01-01T00:00:00.000Z');
	});
});

describe('Workspaces', () => {
	test('initializes empty', () => {
		const workspaces = new Workspaces({app});

		assert.strictEqual(workspaces.items.by_id.size, 0);
		assert.strictEqual(workspaces.active_id, null);
		assert.strictEqual(workspaces.active, undefined);
	});

	test('add creates a workspace and auto-activates first', () => {
		const workspaces = new Workspaces({app});
		const path = DiskfileDirectoryPath.parse('/home/user/project/');

		const workspace = workspaces.add({path, name: 'project', opened_at: '2026-01-01T00:00:00.000Z'});

		assert.strictEqual(workspaces.items.by_id.size, 1);
		assert.strictEqual(workspaces.active_id, workspace.id);
		assert.strictEqual(workspaces.active, workspace);
	});

	test('add deduplicates by path', () => {
		const workspaces = new Workspaces({app});
		const path = DiskfileDirectoryPath.parse('/home/user/project/');

		const first = workspaces.add({path, name: 'project', opened_at: '2026-01-01T00:00:00.000Z'});
		const second = workspaces.add({path, name: 'project', opened_at: '2026-02-01T00:00:00.000Z'});

		assert.strictEqual(first, second);
		assert.strictEqual(workspaces.items.by_id.size, 1);
	});

	test('add multiple workspaces', () => {
		const workspaces = new Workspaces({app});
		const path_a = DiskfileDirectoryPath.parse('/path/a/');
		const path_b = DiskfileDirectoryPath.parse('/path/b/');

		const a = workspaces.add({path: path_a, name: 'a', opened_at: ''});
		const b = workspaces.add({path: path_b, name: 'b', opened_at: ''});

		assert.strictEqual(workspaces.items.by_id.size, 2);
		// First added is auto-activated
		assert.strictEqual(workspaces.active_id, a.id);
		assert.notStrictEqual(a.id, b.id);
	});

	test('remove deletes workspace and updates active_id', () => {
		const workspaces = new Workspaces({app});
		const path_a = DiskfileDirectoryPath.parse('/path/a/');
		const path_b = DiskfileDirectoryPath.parse('/path/b/');

		const a = workspaces.add({path: path_a, name: 'a', opened_at: ''});
		workspaces.add({path: path_b, name: 'b', opened_at: ''});

		assert.strictEqual(workspaces.active_id, a.id);

		workspaces.remove(a.id);

		assert.strictEqual(workspaces.items.by_id.size, 1);
		// active_id should move to remaining workspace
		assert.notStrictEqual(workspaces.active_id, null);
		assert.notStrictEqual(workspaces.active_id, a.id);
	});

	test('remove last workspace sets active_id to null', () => {
		const workspaces = new Workspaces({app});
		const path = DiskfileDirectoryPath.parse('/path/only/');

		const only = workspaces.add({path, name: 'only', opened_at: ''});
		workspaces.remove(only.id);

		assert.strictEqual(workspaces.items.by_id.size, 0);
		assert.strictEqual(workspaces.active_id, null);
	});

	test('get_by_path returns workspace or undefined', () => {
		const workspaces = new Workspaces({app});
		const path = DiskfileDirectoryPath.parse('/home/user/project/');

		assert.strictEqual(workspaces.get_by_path(path), undefined);

		const workspace = workspaces.add({path, name: 'project', opened_at: ''});
		assert.strictEqual(workspaces.get_by_path(path), workspace);
	});

	test('activate changes active workspace', () => {
		const workspaces = new Workspaces({app});
		const path_a = DiskfileDirectoryPath.parse('/path/a/');
		const path_b = DiskfileDirectoryPath.parse('/path/b/');

		const a = workspaces.add({path: path_a, name: 'a', opened_at: ''});
		const b = workspaces.add({path: path_b, name: 'b', opened_at: ''});

		assert.strictEqual(workspaces.active_id, a.id);

		workspaces.activate(b.id);
		assert.strictEqual(workspaces.active_id, b.id);
		assert.strictEqual(workspaces.active, b);
	});

	test('activate with unknown id is a no-op', () => {
		const workspaces = new Workspaces({app});
		const path = DiskfileDirectoryPath.parse('/path/a/');

		const a = workspaces.add({path, name: 'a', opened_at: ''});
		workspaces.activate('nonexistent-id' as Uuid);

		assert.strictEqual(workspaces.active_id, a.id);
	});

	test('initializes from json with items', () => {
		const path_a = DiskfileDirectoryPath.parse('/path/a/');
		const path_b = DiskfileDirectoryPath.parse('/path/b/');

		const workspaces = new Workspaces({
			app,
			json: {
				items: [
					{path: path_a, name: 'a', opened_at: '2026-01-01T00:00:00.000Z'},
					{path: path_b, name: 'b', opened_at: '2026-02-01T00:00:00.000Z'},
				],
			},
		});

		assert.strictEqual(workspaces.items.by_id.size, 2);
		assert.isDefined(workspaces.get_by_path(path_a));
		assert.isDefined(workspaces.get_by_path(path_b));
	});
});

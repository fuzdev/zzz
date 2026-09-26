// @vitest-environment jsdom

import { test, beforeEach, describe, assert } from 'vitest';

import {
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';
import { DiskfileEditorState } from '$lib/diskfile_editor_state.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/ws/');
const PATH_A = DiskfilePath.parse('/ws/a.txt');
const PATH_B = DiskfilePath.parse('/ws/b.txt');
const PATH_C = DiskfilePath.parse('/ws/c.txt');

const create_disknode = (
	path: DiskfilePath,
	contents: string | null = 'contents'
): SerializableDisknode => ({
	id: path,
	source_dir: SOURCE_DIR,
	contents,
	ctime: 1,
	mtime: 1,
	dependents: [],
	dependencies: []
});

let app: Frontend;

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, contents?: string): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, type === 'delete' ? null : contents)
	});
};

const count_by_path = (path: DiskfilePath): number => {
	let count = 0;
	for (const diskfile of app.diskfiles.items.by_id.values()) {
		if (diskfile.path === path) count++;
	}
	return count;
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('upsert by path', () => {
	test('add for an existing path updates it in place', () => {
		filer_change('add', PATH_A, 'one');
		const diskfile = app.diskfiles.get_by_path(PATH_A);
		assert.ok(diskfile);

		filer_change('add', PATH_A, 'two');

		assert.strictEqual(count_by_path(PATH_A), 1);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), diskfile);
		assert.strictEqual(diskfile.content, 'two');
	});

	test('change for an unknown path adds it', () => {
		filer_change('change', PATH_A, 'one');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.content, 'one');
	});

	test('a delete after a duplicate add leaves no ghost', () => {
		filer_change('add', PATH_A, 'one');
		filer_change('add', PATH_A, 'two');
		filer_change('delete', PATH_A);

		assert.strictEqual(count_by_path(PATH_A), 0);
		assert.isUndefined(app.diskfiles.get_by_path(PATH_A));
	});

	test('add_initial upserts overlapping seeds', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a1'), create_disknode(PATH_B, 'b1')]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);

		// e.g. `workspace_open` files overlapping `session_load`'s
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a2'), create_disknode(PATH_C, 'c1')]);

		assert.strictEqual(app.diskfiles.items.size, 3);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), a);
		assert.strictEqual(a.content, 'a2');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B)?.content, 'b1');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_C)?.content, 'c1');
	});
});

describe('delete cleans up editor state', () => {
	test('closes the tab, advances selection, and drops history', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;

		app.diskfiles.select(a.id, true);
		app.diskfiles.select(b.id, true);
		assert.strictEqual(app.diskfiles.selected_file_id, b.id);
		app.create_diskfile_history(PATH_B).add_entry('edited');

		filer_change('delete', PATH_B);

		assert.isUndefined(tabs.by_diskfile_id.get(b.id));
		assert.strictEqual(tabs.items.size, 1);
		assert.strictEqual(tabs.selected_diskfile_id, a.id);
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
		assert.strictEqual(app.diskfiles.selected_file, a);
		assert.isUndefined(app.get_diskfile_history(PATH_B));
	});

	test('disposes the diskfile, its tab, and its history', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		const history = app.create_diskfile_history(PATH_A);
		const { all } = app.cell_registry;
		assert.ok(all.has(a.id) && all.has(tab.id) && all.has(history.id));

		filer_change('delete', PATH_A);

		assert.ok(!all.has(a.id));
		assert.ok(!all.has(tab.id));
		assert.ok(!all.has(history.id));
	});

	test('clears selection when no tab remains', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);

		filer_change('delete', PATH_A);

		assert.isNull(app.diskfiles.selected_file_id);
		assert.isNull(app.diskfiles.selected_file);
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0);
	});

	test('the deleted file cannot be reopened or navigated back to', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;

		app.diskfiles.select(a.id, true);
		const b_tab = tabs.open_diskfile(b.id);
		tabs.close_tab(b_tab.id);
		assert.strictEqual(tabs.closed_tab_diskfiles.get(b_tab.id), b.id);

		filer_change('delete', PATH_B);

		tabs.reopen_last_closed_tab();
		assert.isUndefined(tabs.by_diskfile_id.get(b.id));
		assert.deepEqual(tabs.navigate_to_tab(b_tab.id), {
			resulting_tab_id: null,
			created_preview: false
		});
	});

	test('keeps unrelated selection and tabs', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;

		app.diskfiles.select(b.id, true);
		app.diskfiles.select(a.id, true);

		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
		assert.strictEqual(tabs.selected_diskfile_id, a.id);
		assert.strictEqual(tabs.items.size, 1);
	});

	test('deleting an unknown path is a no-op', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		filer_change('delete', PATH_B);
		assert.strictEqual(app.diskfiles.items.size, 1);
	});
});

describe('delete with unsaved edits keeps the tab', () => {
	const setup_dirty = () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a'), create_disknode(PATH_B, 'b')]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		app.diskfiles.select(a.id, true);
		app.diskfiles.select(b.id, true);
		const editor_state = new DiskfileEditorState({ app, diskfile: b });
		editor_state.current_content = 'b edited';
		assert.ok(app.get_diskfile_history(PATH_B)?.has_unsaved_edits);
		return { a, b, editor_state, tabs: app.diskfiles.editor.tabs };
	};

	test('the diskfile, tab, selection, and history stay, flagged deleted', () => {
		const { b, tabs } = setup_dirty();

		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.ok(tabs.by_diskfile_id.get(b.id));
		assert.strictEqual(tabs.selected_diskfile_id, b.id);
		assert.strictEqual(app.diskfiles.selected_file_id, b.id);
		assert.ok(app.get_diskfile_history(PATH_B)?.has_unsaved_edits);
		assert.notInclude(app.diskfiles.on_disk, b);
		assert.strictEqual(app.diskfiles.on_disk.length, 1);
	});

	test('recreating the path reattaches the same diskfile and clears the flag', () => {
		const { b, tabs, editor_state } = setup_dirty();
		const tab = tabs.by_diskfile_id.get(b.id);
		filer_change('delete', PATH_B);

		filer_change('add', PATH_B, 'b recreated');

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.strictEqual(count_by_path(PATH_B), 1);
		assert.isFalse(b.deleted_on_disk);
		assert.strictEqual(b.content, 'b recreated');
		assert.strictEqual(tabs.by_diskfile_id.get(b.id), tab);
		assert.include(app.diskfiles.on_disk, b);
		// the unsaved edit survives the round trip
		assert.strictEqual(editor_state.current_content, 'b edited');
	});

	test('saving writes the path back', async () => {
		const { editor_state } = setup_dirty();
		const writes: Array<[string, string]> = [];
		app.diskfiles.update = (path, content) => {
			writes.push([path, content]);
			return Promise.resolve({ ok: true, value: null });
		};
		filer_change('delete', PATH_B);

		assert.isTrue(await editor_state.save_changes());

		assert.deepEqual(writes, [[PATH_B, 'b edited']]);
	});

	test('closing the tab discards the diskfile and its history', () => {
		const { a, b, tabs } = setup_dirty();
		filer_change('delete', PATH_B);
		const tab = tabs.by_diskfile_id.get(b.id);
		assert.ok(tab);

		app.diskfiles.editor.close_tab(tab.id);

		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
		assert.isUndefined(app.get_diskfile_history(PATH_B));
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
		tabs.reopen_last_closed_tab();
		assert.isUndefined(tabs.by_diskfile_id.get(b.id));
	});

	test('closing all tabs discards it too', () => {
		const { b, tabs } = setup_dirty();
		filer_change('delete', PATH_B);

		tabs.close_all_tabs();

		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
		assert.ok(app.diskfiles.get_by_path(PATH_A));
		assert.ok(tabs.recently_closed_tabs.every((t) => t.diskfile_id !== b.id));
	});

	test('closing a tab of a file still on disk keeps it', () => {
		const { a, tabs } = setup_dirty();
		const tab = tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);

		tabs.close_tab(tab.id);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), a);
	});

	test('unsaved edits without an open tab do not keep a deleted file', () => {
		const { b, tabs } = setup_dirty();
		const tab = tabs.by_diskfile_id.get(b.id);
		assert.ok(tab);
		tabs.close_tab(tab.id);

		filer_change('delete', PATH_B);

		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
	});

	test('saving recreates the file even with nothing left to save', async () => {
		const { b, editor_state } = setup_dirty();
		// back to the original entry: history keeps the unsaved alternate while
		// the editor matches disk
		const original = app
			.get_diskfile_history(PATH_B)
			?.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);
		assert.isFalse(editor_state.has_changes);
		assert.ok(app.get_diskfile_history(PATH_B)?.has_unsaved_edits);
		const writes: Array<[string, string]> = [];
		app.diskfiles.update = (path, content) => {
			writes.push([path, content]);
			return Promise.resolve({ ok: true, value: null });
		};

		filer_change('delete', PATH_B);
		assert.isTrue(b.deleted_on_disk);
		assert.isTrue(editor_state.can_save);

		assert.isTrue(await editor_state.save_changes());
		assert.deepEqual(writes, [[PATH_B, 'b']]);
	});

	test('a file open in two tabs is kept until its last tab closes', () => {
		const { b, tabs } = setup_dirty();
		const first = tabs.by_diskfile_id.get(b.id);
		assert.ok(first);
		tabs.close_tab(first.id);
		tabs.open_diskfile(b.id);
		tabs.reopen_last_closed_tab(); // a second tab for b
		const b_tabs = tabs.ordered_tabs.filter((t) => t.diskfile_id === b.id);
		assert.strictEqual(b_tabs.length, 2);

		filer_change('delete', PATH_B);
		assert.isTrue(b.deleted_on_disk);

		tabs.close_tab(b_tabs[0]!.id);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);

		tabs.close_tab(b_tabs[1]!.id);
		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
		assert.isUndefined(app.get_diskfile_history(PATH_B));
	});

	test('reusing a preview tab away from the file forgets it', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a'), create_disknode(PATH_B, 'b')]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;
		const preview = tabs.preview_diskfile(b.id);
		new DiskfileEditorState({ app, diskfile: b }).current_content = 'b edited';

		filer_change('delete', PATH_B);
		assert.isTrue(b.deleted_on_disk);
		assert.strictEqual(tabs.preview_tab_id, preview.id);

		tabs.preview_diskfile(a.id);

		assert.strictEqual(preview.diskfile_id, a.id);
		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
	});

	test('a repeated delete keeps it flagged', () => {
		const { b, tabs } = setup_dirty();
		filer_change('delete', PATH_B);
		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.ok(tabs.by_diskfile_id.get(b.id));
		assert.strictEqual(count_by_path(PATH_B), 1);
	});

	test('a diskfile part treats a flagged file as missing', () => {
		const { b } = setup_dirty();
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		assert.strictEqual(part.diskfile, b);
		assert.strictEqual(part.content, 'b');

		filer_change('delete', PATH_B);

		assert.isUndefined(part.diskfile);
		assert.isUndefined(part.content);

		filer_change('add', PATH_B, 'b back');
		assert.strictEqual(part.diskfile, b);
		assert.strictEqual(part.content, 'b back');
	});
});

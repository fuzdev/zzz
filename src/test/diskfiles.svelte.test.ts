// @vitest-environment jsdom

import { test, beforeEach, describe, assert } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import {
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';

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
	test('an unchanged file is left untouched', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'same')]);
		const diskfile = app.diskfiles.get_by_path(PATH_A);
		assert.ok(diskfile);
		diskfile.updated = '2000-01-01T00:00:00.000Z' as typeof diskfile.updated;

		app.diskfiles.add_initial([create_disknode(PATH_A, 'same')]);
		assert.strictEqual(diskfile.updated, '2000-01-01T00:00:00.000Z', 'not bumped');

		app.diskfiles.add_initial([create_disknode(PATH_A, 'different')]);
		assert.strictEqual(diskfile.content, 'different');
		assert.notStrictEqual(diskfile.updated, '2000-01-01T00:00:00.000Z');
	});

	test('a source_dir change alone still upserts', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'same')]);
		const diskfile = app.diskfiles.get_by_path(PATH_A);
		assert.ok(diskfile);
		const other_dir = SerializableDisknode.shape.source_dir.parse('/');
		app.diskfiles.add_initial([{ ...create_disknode(PATH_A, 'same'), source_dir: other_dir }]);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), diskfile, 'same diskfile');
		assert.strictEqual(diskfile.source_dir, other_dir);
	});

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
		const b_state = app.diskfiles.get_editor_state(b);
		b_state.history.add_entry('edited');

		filer_change('delete', PATH_B);

		assert.isUndefined(tabs.by_diskfile_id.get(b.id));
		assert.strictEqual(tabs.items.size, 1);
		assert.strictEqual(tabs.selected_diskfile_id, a.id);
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
		assert.strictEqual(app.diskfiles.selected_file, a);
		assert.isUndefined(app.diskfiles.find_editor_state(b.id));
		assert.ok(!app.cell_registry.all.has(b_state.history.id));
	});

	test('disposes the diskfile, its tab, and its history', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.id, true);
		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);
		const { history } = app.diskfiles.get_editor_state(a);
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
		app.diskfiles.select(a.id);
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
		assert.isNull(tabs.navigate_to_tab(b_tab.id));
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
		const editor_state = app.diskfiles.get_editor_state(b);
		editor_state.current_content = 'b edited';
		assert.ok(editor_state.has_unsaved_edits);
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
		assert.ok(app.diskfiles.find_editor_state(b.id)?.has_unsaved_edits);
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

	test('closing the tab after discarding the draft forgets the diskfile ("don\'t save")', () => {
		const { a, b, tabs, editor_state } = setup_dirty();
		filer_change('delete', PATH_B);
		const tab = tabs.by_diskfile_id.get(b.id);
		assert.ok(tab);

		editor_state.discard_draft();
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b, 'kept while its tab is open');
		app.diskfiles.editor.close_tab(tab.id);

		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
		assert.isUndefined(app.diskfiles.find_editor_state(b.id));
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
		tabs.reopen_last_closed_tab();
		assert.isUndefined(tabs.by_diskfile_id.get(b.id));
	});

	test('closing the tab with the draft kept keeps the diskfile, listed for the draft', () => {
		const { b, tabs } = setup_dirty();
		filer_change('delete', PATH_B);
		const tab = tabs.by_diskfile_id.get(b.id);
		assert.ok(tab);

		app.diskfiles.editor.close_tab(tab.id);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.include(app.diskfiles.listed, b);
		assert.notInclude(app.diskfiles.on_disk, b);
		assert.strictEqual(app.diskfiles.find_editor_state(b.id)?.current_content, 'b edited');
	});
	test('closing all tabs keeps the draft too', () => {
		const { b, tabs } = setup_dirty();
		filer_change('delete', PATH_B);

		tabs.close_all_tabs();

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.ok(app.diskfiles.get_by_path(PATH_A));
		assert.isTrue(app.diskfiles.find_editor_state(b.id)?.has_unsaved_edits);
	});
	test('closing a tab of a file still on disk keeps it', () => {
		const { a, tabs } = setup_dirty();
		const tab = tabs.by_diskfile_id.get(a.id);
		assert.ok(tab);

		tabs.close_tab(tab.id);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_A), a);
	});

	test('unsaved edits without an open tab keep a deleted file too', () => {
		const { b, tabs } = setup_dirty();
		const tab = tabs.by_diskfile_id.get(b.id);
		assert.ok(tab);
		tabs.close_tab(tab.id);

		filer_change('delete', PATH_B);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
	});

	test('a draft from a file part (never in a tab) keeps a deleted or pruned file', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a'), create_disknode(PATH_B, 'b')]);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(b);
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		app.diskfiles.get_editor_state(b).current_content = 'part draft';
		assert.isFalse(app.diskfiles.editor.tabs.by_diskfile_id.has(b.id));

		app.diskfiles.reconcile([create_disknode(PATH_A, 'a')], ['/ws/']);

		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.isTrue(b.deleted_on_disk);
		assert.strictEqual(part.diskfile, b);
		assert.strictEqual(part.content, 'part draft');
		assert.strictEqual(part.draft_status, 'deleted');

		// discarding the draft lets it go
		app.diskfiles.get_editor_state(b).discard_draft();
		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
		assert.isUndefined(part.diskfile);
	});

	test('a file without a draft is not kept', () => {
		app.diskfiles.add_initial([create_disknode(PATH_B, 'b')]);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(b);
		app.diskfiles.get_editor_state(b);

		filer_change('delete', PATH_B);

		assert.isUndefined(app.diskfiles.get_by_path(PATH_B));
	});
	test('saving recreates the file even with nothing left to save', async () => {
		const { b, editor_state } = setup_dirty();
		// back to the original entry: history keeps the unsaved alternate while
		// the editor matches disk
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);
		assert.isFalse(editor_state.has_changes);
		assert.ok(editor_state.has_unsaved_edits);
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

	test('reusing a preview tab away from the file keeps its draft', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A, 'a'), create_disknode(PATH_B, 'b')]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { tabs } = app.diskfiles.editor;
		const preview = tabs.preview_diskfile(b.id);
		app.diskfiles.get_editor_state(b).current_content = 'b edited';

		filer_change('delete', PATH_B);
		assert.isTrue(b.deleted_on_disk);
		assert.strictEqual(tabs.preview_tab_id, preview.id);

		tabs.preview_diskfile(a.id);

		assert.strictEqual(preview.diskfile_id, a.id);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B), b);
		assert.include(app.diskfiles.listed, b);
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

	test('a diskfile part shows a flagged file for its draft', () => {
		const { b, editor_state } = setup_dirty();
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		assert.strictEqual(part.diskfile, b);
		// the part sends the draft, marked
		assert.strictEqual(part.content, 'b edited');
		assert.strictEqual(part.draft_status, 'unsaved');

		filer_change('delete', PATH_B);

		assert.strictEqual(part.diskfile, b);
		assert.strictEqual(part.content, 'b edited');
		assert.strictEqual(part.draft_status, 'deleted');

		filer_change('add', PATH_B, 'b back');
		assert.strictEqual(part.diskfile, b);
		// the draft is kept over the recreated file, as a conflict
		assert.strictEqual(part.content, 'b edited');
		assert.strictEqual(part.draft_status, 'conflict');
		assert.isTrue(editor_state.has_conflict);

		editor_state.discard_draft();
		assert.strictEqual(part.content, 'b back');
		assert.isNull(part.draft_status);
	});

	test('a diskfile part sends the draft, not an older entry an editor views', () => {
		const { editor_state } = setup_dirty();
		const part = app.cell_registry.instantiate('DiskfilePart', { type: 'diskfile', path: PATH_B });
		const original = editor_state.history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		const older = editor_state.history.add_entry('older', { created: 1 });

		editor_state.set_content_from_history(older.id);
		assert.strictEqual(part.content, 'b edited');

		editor_state.clear_unsaved_edits();
		editor_state.set_content_from_history(older.id);
		assert.strictEqual(part.content, 'b');
		assert.isNull(part.draft_status);
	});
});

describe('path_relative', () => {
	const ZZZ_DIR = SerializableDisknode.shape.source_dir.parse('/zzz/');

	test('is relative inside the zzz dir and absolute outside it', () => {
		app.zzz_dir = ZZZ_DIR;
		const inside = DiskfilePath.parse('/zzz/notes/a.md');
		app.diskfiles.add_initial([create_disknode(inside), create_disknode(PATH_A)]);

		assert.strictEqual(app.diskfiles.get_by_path(inside)?.path_relative, 'notes/a.md');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.path_relative, '/ws/a.txt');
	});

	test('a file part outside the zzz dir gets the absolute path as its `path` attribute', () => {
		app.zzz_dir = ZZZ_DIR;
		app.diskfiles.add_initial([create_disknode(PATH_A)]);

		const part = app.parts.add({ type: 'diskfile', path: PATH_A });

		assert.strictEqual(part.attributes.find((a) => a.key === 'path')?.value, '/ws/a.txt');
	});
});

describe('create_file', () => {
	test('creates in the active workspace through `diskfile_create`, never `diskfile_update`', async () => {
		const calls: Array<[string, unknown]> = [];
		(app as any).api = {
			diskfile_create: (input: unknown) => {
				calls.push(['diskfile_create', input]);
				return Promise.resolve({ ok: true, value: null });
			},
			diskfile_update: (input: unknown) => {
				calls.push(['diskfile_update', input]);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.zzz_dir = SerializableDisknode.shape.source_dir.parse('/zzz/');
		app.workspaces.add({ path: SOURCE_DIR });

		await app.diskfiles.create_file('/new.txt');

		assert.deepEqual(calls, [['diskfile_create', { path: '/ws/new.txt', content: '' }]]);
	});

	test('refuses when no workspace is open', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			diskfile_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.zzz_dir = SerializableDisknode.shape.source_dir.parse('/zzz/');
		assert.isNull(app.diskfiles.new_files_dir);

		const error = await app.diskfiles.create_file('new.txt').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.include(error.message, 'no workspace is open');
		assert.deepEqual(calls, []);
	});

	test('surfaces an existing file as "already exists"', async () => {
		(app as any).api = {
			diskfile_create: () =>
				Promise.resolve({
					ok: false,
					error: {
						code: -32004,
						message: 'failed to create file: Path already exists: /ws/taken.txt',
						data: { reason: 'already_exists' }
					}
				})
		};
		app.workspaces.add({ path: SOURCE_DIR });

		const error = await app.diskfiles.create_file('taken.txt').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.strictEqual(error.message, 'taken.txt already exists');
	});
});

describe('selection on add', () => {
	test('a file seeded by a snapshot is not selected', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);

		assert.isNull(app.diskfiles.selected_file_id);
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0);
	});

	test('a file another tool creates is not selected, with nothing selected', () => {
		filer_change('add', PATH_A);

		assert.isNull(app.diskfiles.selected_file_id);
		assert.strictEqual(app.diskfiles.editor.tabs.items.size, 0);
	});

	test('a file another tool creates leaves the selection and tabs alone', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.id);
		const { tabs } = app.diskfiles.editor;
		const tab = tabs.selected_tab;
		assert.ok(tab);

		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
		assert.strictEqual(tabs.selected_tab, tab);
		assert.deepEqual(tabs.ordered_tabs, [tab]);
	});
});

describe('reopening a closed tab', () => {
	test('selects the reopened file', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.id, true);
		app.diskfiles.select(b.id, true);
		const b_tab = editor.tabs.by_diskfile_id.get(b.id);
		assert.ok(b_tab);
		editor.close_tab(b_tab.id);
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);

		editor.reopen_last_closed_tab();

		assert.strictEqual(editor.tabs.selected_diskfile_id, b.id);
		assert.strictEqual(app.diskfiles.selected_file_id, b.id);
	});
});

describe('back/forward navigation', () => {
	test('selects the file of the tab navigated to', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.id, true);
		const a_tab = editor.tabs.selected_tab;
		assert.ok(a_tab);
		app.diskfiles.select(b.id, true);

		assert.strictEqual(editor.navigate_to_tab(a_tab.id), a_tab.id);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	test('a closed tab navigated to selects its file in a new preview', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.id, true);
		const a_tab = editor.tabs.selected_tab;
		assert.ok(a_tab);
		app.diskfiles.select(b.id, true);
		editor.close_tab(a_tab.id);

		const tab_id = editor.navigate_to_tab(a_tab.id);

		assert.ok(tab_id);
		assert.strictEqual(editor.tabs.items.by_id.get(tab_id)?.diskfile_id, a.id);
		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	test('an unknown tab leaves the selection alone', () => {
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.id, true);

		assert.isNull(app.diskfiles.editor.navigate_to_tab(create_uuid()));

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});
});

describe('DiskfilesEditor.handle_file_modified', () => {
	test("promotes the modified file's preview tab and leaves others alone", () => {
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(a && b);
		const { editor } = app.diskfiles;
		app.diskfiles.select(a.id, true);
		app.diskfiles.select(b.id);
		const b_tab = editor.tabs.preview_tab;
		assert.strictEqual(b_tab?.diskfile_id, b.id);

		editor.handle_file_modified(a.id);
		assert.strictEqual(editor.tabs.preview_tab, b_tab, 'another file leaves the preview');

		editor.handle_file_modified(b.id);
		assert.isNull(editor.tabs.preview_tab_id);
		assert.strictEqual(editor.tabs.by_diskfile_id.get(b.id), b_tab, 'the same tab, now permanent');
	});
});

describe('create_file selects the new file', () => {
	const setup = (on_create?: () => void) => {
		(app as any).api = {
			diskfile_create: () => {
				on_create?.();
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.workspaces.add({ path: SOURCE_DIR });
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		const a = app.diskfiles.get_by_path(PATH_A);
		assert.ok(a);
		app.diskfiles.select(a.id);
		return a;
	};

	test('when its `filer_change` arrives after the response', async () => {
		const a = setup();

		await app.diskfiles.create_file('b.txt');
		assert.strictEqual(app.diskfiles.selected_file_id, a.id, 'not there yet');

		filer_change('add', PATH_C);
		assert.strictEqual(app.diskfiles.selected_file_id, a.id, 'an unrelated file');

		filer_change('add', PATH_B);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(b);
		assert.strictEqual(app.diskfiles.selected_file_id, b.id);
		const { tabs } = app.diskfiles.editor;
		assert.strictEqual(tabs.selected_diskfile_id, b.id);
		assert.notStrictEqual(tabs.preview_tab_id, tabs.selected_tab_id, 'a permanent tab');
	});

	test('when its `filer_change` arrived before the response', async () => {
		setup(() => filer_change('add', PATH_B));

		await app.diskfiles.create_file('b.txt');

		const b = app.diskfiles.get_by_path(PATH_B);
		assert.ok(b);
		assert.strictEqual(app.diskfiles.selected_file_id, b.id);
		assert.strictEqual(app.diskfiles.editor.tabs.selected_diskfile_id, b.id);
	});

	test('only once — a later re-add of the path by another tool does not select it', async () => {
		const a = setup(() => filer_change('add', PATH_B));
		await app.diskfiles.create_file('b.txt');
		app.diskfiles.select(a.id);

		filer_change('delete', PATH_B);
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	for (const filename of ['./b.txt', 'sub/../b.txt', '/b.txt', 'sub//../b.txt']) {
		test(`a name the backend normalizes (${filename}) is selected by its normalized path`, async () => {
			setup();

			await app.diskfiles.create_file(filename);
			filer_change('add', PATH_B);

			assert.strictEqual(app.diskfiles.selected_file_id, app.diskfiles.get_by_path(PATH_B)?.id);
		});
	}

	test('selecting another file drops the pending selection', async () => {
		const a = setup();
		await app.diskfiles.create_file('b.txt');

		app.diskfiles.select(a.id);
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	test('a tab change through the editor drops the pending selection', async () => {
		const scenarios: Array<[string, (a_tab_id: Uuid, c_tab_id: Uuid) => void]> = [
			['open', (a_tab_id) => app.diskfiles.editor.open_tab(a_tab_id)],
			['navigate', (a_tab_id) => app.diskfiles.editor.navigate_to_tab(a_tab_id)],
			['close the selected tab', (_, c_tab_id) => app.diskfiles.editor.close_tab(c_tab_id)],
			[
				'reopen',
				(_, c_tab_id) => {
					app.diskfiles.editor.tabs.close_tab(c_tab_id);
					app.diskfiles.editor.reopen_last_closed_tab();
				}
			]
		];
		for (const [name, change_tab] of scenarios) {
			app.dispose();
			app = monkeypatch_zzz_for_tests(new Frontend());
			setup();
			const a_tab = app.diskfiles.editor.tabs.selected_tab;
			app.diskfiles.add_initial([create_disknode(PATH_C)]);
			const c = app.diskfiles.get_by_path(PATH_C);
			assert.ok(a_tab && c);
			app.diskfiles.select(c.id, true);
			const c_tab = app.diskfiles.editor.tabs.selected_tab;
			assert.ok(c_tab);
			await app.diskfiles.create_file('b.txt');

			change_tab(a_tab.id, c_tab.id);
			const selected = app.diskfiles.selected_file_id;
			filer_change('add', PATH_B);

			assert.strictEqual(app.diskfiles.selected_file_id, selected, name);
			assert.notStrictEqual(selected, app.diskfiles.get_by_path(PATH_B)?.id, name);
		}
	});

	test('removing its workspace drops the pending selection', async () => {
		const a = setup();
		await app.diskfiles.create_file('b.txt');

		app.workspaces.remove_by_path(SOURCE_DIR);
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});

	test('the next create replaces the pending selection', async () => {
		setup();
		await app.diskfiles.create_file('b.txt');
		await app.diskfiles.create_file('c.txt');

		filer_change('add', PATH_B);
		const b = app.diskfiles.get_by_path(PATH_B);
		assert.notStrictEqual(app.diskfiles.selected_file_id, b?.id);

		filer_change('add', PATH_C);
		assert.strictEqual(app.diskfiles.selected_file_id, app.diskfiles.get_by_path(PATH_C)?.id);
	});

	test('a failed create selects nothing', async () => {
		const a = setup();
		(app as any).api = {
			diskfile_create: () =>
				Promise.resolve({ ok: false, error: { code: -32603, message: 'nope' } })
		};

		await app.diskfiles.create_file('b.txt').catch(() => {});
		filer_change('add', PATH_B);

		assert.strictEqual(app.diskfiles.selected_file_id, a.id);
	});
});

describe('create_directory', () => {
	test('creates in the active workspace', async () => {
		const calls: Array<unknown> = [];
		(app as any).api = {
			directory_create: (input: unknown) => {
				calls.push(input);
				return Promise.resolve({ ok: true, value: null });
			}
		};
		app.workspaces.add({ path: SOURCE_DIR });

		await app.diskfiles.create_directory('sub/dir');

		assert.deepEqual(calls, [{ path: '/ws/sub/dir' }]);
	});

	test('refuses when no workspace is open', async () => {
		(app as any).api = {
			directory_create: () => Promise.resolve({ ok: true, value: null })
		};

		const error = await app.diskfiles.create_directory('sub').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.include(error.message, 'no workspace is open');
	});

	test('throws the backend error instead of swallowing it', async () => {
		(app as any).api = {
			directory_create: () =>
				Promise.resolve({
					ok: false,
					error: { code: -32003, message: 'failed to create directory: permission denied' }
				})
		};
		app.workspaces.add({ path: SOURCE_DIR });

		const error = await app.diskfiles.create_directory('sub').then(
			() => null,
			(e: unknown) => e
		);
		assert.instanceOf(error, Error);
		assert.strictEqual(error.message, 'failed to create directory: permission denied');
	});
});

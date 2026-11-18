// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert } from 'vitest';

import type { DiskfileEditorState } from '#lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

/**
 * Comparing a file (`compare_choice`, `comparing`, `compare_base_content`):
 * the choice is kept by path through `file_compare_set`, and the diff is
 * from the disk content or a history entry to `current_content`.
 */

const PATH = parse_or_throw(DiskfilePath, '/w/a.txt');
const OTHER = parse_or_throw(DiskfilePath, '/w/b.txt');
const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let diskfile: Diskfile;
let editor_state: DiskfileEditorState;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	diskfile = app.diskfiles.add({ path: PATH, source_dir: SOURCE_DIR, content: 'v1' });
	editor_state = app.diskfiles.get_editor_state(diskfile);
});

afterEach(() => {
	app.dispose();
});

describe('comparing a file', () => {
	test('is off until chosen', () => {
		assert.isNull(editor_state.compare_choice);
		assert.isFalse(editor_state.comparing);
		assert.strictEqual(editor_state.compare_base_content, 'v1');
	});

	test('`file_compare_set` compares against the disk, and `null` stops it', () => {
		editor_state.current_content = 'mine';
		assert.deepEqual(app.intents.file_compare_set({ path: PATH, base: 'disk' }), {
			comparing: true
		});
		assert.isTrue(editor_state.comparing);
		assert.strictEqual(editor_state.compare_base_content, 'v1');
		assert.strictEqual(editor_state.current_content, 'mine', 'the edit is untouched');
		assert.isTrue(editor_state.can_edit, 'comparing changes nothing the editor takes');

		assert.deepEqual(app.intents.file_compare_set({ path: PATH, base: null }), {
			comparing: false
		});
		assert.isFalse(editor_state.comparing);
		assert.isFalse(app.diskfiles.compare_bases.has(PATH));
	});

	test('a clean file compares too, its base its own content', () => {
		app.intents.file_compare_set({ path: PATH, base: 'disk' });
		assert.isTrue(editor_state.comparing);
		assert.strictEqual(editor_state.compare_base_content, editor_state.current_content);
	});

	test('a file whose content is not loaded is not compared, the choice kept', () => {
		const unloaded = app.diskfiles.add({ path: OTHER, source_dir: SOURCE_DIR });
		const state = app.diskfiles.get_editor_state(unloaded);
		app.intents.file_compare_set({ path: OTHER, base: 'disk' });
		assert.strictEqual(state.compare_choice, 'disk');
		assert.isFalse(state.comparing);
		assert.isNull(state.compare_base_content);
	});

	test('a history entry is the base when chosen', () => {
		const entry = editor_state.history.add_entry('older');
		editor_state.current_content = 'mine';
		app.intents.file_compare_set({ path: PATH, base: entry.id });
		assert.strictEqual(editor_state.compare_base_entry?.id, entry.id);
		assert.strictEqual(editor_state.compare_base_content, 'older');
	});

	test('the draft entry can be the base', () => {
		editor_state.current_content = 'mine';
		const draft_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft_id);
		app.intents.file_compare_set({ path: PATH, base: draft_id });
		assert.strictEqual(editor_state.compare_base_content, 'mine');
	});

	test('an entry gone from the history falls back to the disk', () => {
		const entry = editor_state.history.add_entry('older');
		app.intents.file_compare_set({ path: PATH, base: entry.id });
		editor_state.clear_history();
		assert.isTrue(editor_state.comparing, 'still compared');
		assert.isNull(editor_state.compare_base_entry);
		assert.strictEqual(editor_state.compare_base_content, 'v1');
	});

	test('the choice is kept by path, with no editing state made for it', () => {
		assert.deepEqual(app.intents.file_compare_set({ path: OTHER, base: 'disk' }), {
			comparing: true
		});
		assert.isUndefined(app.diskfiles.find_editor_state(OTHER));
		assert.strictEqual(app.diskfiles.compare_bases.get(OTHER), 'disk');
	});

	test("closing the file's tab ends the compare, so it reopens on the editor", () => {
		app.intents.tab_open({ path: PATH, permanent: true });
		app.intents.file_compare_set({ path: PATH, base: 'disk' });
		app.intents.tab_close({ path: PATH });
		assert.isFalse(app.diskfiles.compare_bases.has(PATH));
		assert.isFalse(editor_state.comparing);
	});

	test('`diff_split_toggle` toggles, or sets, a choice every diff shares', () => {
		assert.isFalse(app.ui.diff_split);
		assert.deepEqual(app.intents.diff_split_toggle(), { split: true });
		assert.deepEqual(app.intents.diff_split_toggle({ split: true }), { split: true });
		assert.deepEqual(app.intents.diff_split_toggle({ split: false }), { split: false });
		assert.isFalse(app.ui.diff_split);
	});

	test('refuses a base that is not one', () => {
		assert.throws(() => app.intents.file_compare_set({ path: PATH, base: 'nope' }));
		assert.isFalse(app.diskfiles.compare_bases.has(PATH));
	});
});

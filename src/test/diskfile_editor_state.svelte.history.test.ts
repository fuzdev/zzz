// @vitest-environment jsdom

import {test, beforeEach, describe, assert} from 'vitest';

import {DiskfileEditorState} from '$lib/diskfile_editor_state.svelte.js';
import {DiskfilePath, SerializableDisknode} from '$lib/diskfile_types.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {Diskfile} from '$lib/diskfile.svelte.js';
import {monkeypatch_zzz_for_tests} from './test_helpers.ts';

// Constants for testing
const TEST_PATH = DiskfilePath.parse('/path/to/test.txt');
const TEST_DIR = SerializableDisknode.shape.source_dir.parse('/path/');
const TEST_CONTENT = 'This is test content';

// Test suite variables
let app: Frontend;
let test_diskfile: Diskfile;
let editor_state: DiskfileEditorState;

beforeEach(() => {
	// Create a real Zzz instance for each test
	app = monkeypatch_zzz_for_tests(new Frontend());

	// Create a real diskfile through the registry
	test_diskfile = app.diskfiles.add({
		path: TEST_PATH,
		source_dir: TEST_DIR,
		content: TEST_CONTENT,
	});

	// Create the editor state with real components
	editor_state = new DiskfileEditorState({
		app,
		diskfile: test_diskfile,
	});
});

describe('unsaved edit creation', () => {
	test('updating content creates an unsaved entry and updates selection', () => {
		// Update content
		const new_content = 'Modified content';
		editor_state.current_content = new_content;

		// Verify an unsaved entry was created
		assert.ok(editor_state.unsaved_edit_entry_id !== null);

		// Verify the new entry
		const history = app.get_diskfile_history(TEST_PATH)!;
		const new_entry = history.find_entry_by_id(editor_state.unsaved_edit_entry_id!);

		assert.include(new_entry, {
			content: new_content,
			is_unsaved_edit: true,
			label: 'Unsaved edit',
		});

		// Selection should match the unsaved entry
		assert.strictEqual(editor_state.selected_history_entry_id, editor_state.unsaved_edit_entry_id);
	});

	test('multiple content updates modify the same unsaved entry', () => {
		// Make initial edit
		editor_state.current_content = 'First edit';

		// Track the entry id
		const unsaved_id = editor_state.unsaved_edit_entry_id;
		assert.ok(unsaved_id !== null);

		// Make additional edits
		editor_state.current_content = 'Second edit';
		editor_state.current_content = 'Third edit';

		// Verify the same entry was updated
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_id);

		// Verify the entry content was updated
		const history = app.get_diskfile_history(TEST_PATH)!;
		const updated_entry = history.find_entry_by_id(unsaved_id!);

		assert.include(updated_entry, {
			content: 'Third edit',
			is_unsaved_edit: true,
		});
	});

	test('setting content back to original removes unsaved entry', () => {
		// Make an edit to create unsaved entry
		editor_state.current_content = 'Edited content';
		const unsaved_id = editor_state.unsaved_edit_entry_id;

		// Set content back to original
		editor_state.current_content = TEST_CONTENT;

		// Verify unsaved entry was removed
		assert.isNull(editor_state.unsaved_edit_entry_id);

		// Entry should no longer exist
		const history = app.get_diskfile_history(TEST_PATH)!;
		assert.ok(history.find_entry_by_id(unsaved_id!) === undefined);
	});

	test('editing to match existing content selects that entry instead of creating new one', () => {
		// Create entries in history
		const history = app.get_diskfile_history(TEST_PATH)!;
		const existing_entry = history.add_entry('Existing content');

		// Edit to match existing content
		editor_state.current_content = 'Existing content';

		// Existing entry should be selected
		assert.strictEqual(editor_state.selected_history_entry_id, existing_entry.id);
		assert.isNull(editor_state.unsaved_edit_entry_id);
	});

	test('editing to match existing unsaved edit selects that entry', () => {
		// Create an unsaved entry
		const history = app.get_diskfile_history(TEST_PATH)!;
		const unsaved_entry = history.add_entry('Unsaved content', {is_unsaved_edit: true});

		// Select a different entry
		const other_entry = history.add_entry('Other content');
		editor_state.set_content_from_history(other_entry.id);

		// Edit to match the unsaved entry
		editor_state.current_content = 'Unsaved content';

		// The existing unsaved entry should be selected
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved_entry.id);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_entry.id);
	});
});

describe('history navigation', () => {
	test('set_content_from_history loads content and updates selection', () => {
		// Create history entries
		const history = app.get_diskfile_history(TEST_PATH)!;
		const entry1 = history.add_entry('Entry 1');
		const entry2 = history.add_entry('Entry 2');

		// Select first entry
		editor_state.set_content_from_history(entry1.id);

		// Verify selection and content
		assert.strictEqual(editor_state.selected_history_entry_id, entry1.id);
		assert.strictEqual(editor_state.current_content, 'Entry 1');

		// Select second entry
		editor_state.set_content_from_history(entry2.id);

		// Verify selection and content updated
		assert.strictEqual(editor_state.selected_history_entry_id, entry2.id);
		assert.strictEqual(editor_state.current_content, 'Entry 2');
	});

	test('set_content_from_history with unsaved edit sets unsaved_edit_entry_id', () => {
		// Create unsaved entry
		const history = app.get_diskfile_history(TEST_PATH)!;
		const unsaved_entry = history.add_entry('Unsaved content', {is_unsaved_edit: true});

		// Select unsaved entry
		editor_state.set_content_from_history(unsaved_entry.id);

		// Verify both ids are set correctly
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved_entry.id);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_entry.id);
	});

	test('set_content_from_history with saved entry clears unsaved_edit_entry_id', () => {
		// Create entries
		const history = app.get_diskfile_history(TEST_PATH)!;
		const saved_entry = history.add_entry('Saved content');

		// First select an unsaved entry
		editor_state.current_content = 'Unsaved content';
		assert.ok(editor_state.unsaved_edit_entry_id !== null);

		// Now select the saved entry
		editor_state.set_content_from_history(saved_entry.id);

		// Verify unsaved edit id is cleared
		assert.strictEqual(editor_state.selected_history_entry_id, saved_entry.id);
		assert.isNull(editor_state.unsaved_edit_entry_id);
	});

	test('content_matching_entry_ids tracks entries with matching content', () => {
		// Create entries with duplicate content
		const history = app.get_diskfile_history(TEST_PATH)!;
		const entry1 = history.add_entry('Unique content');
		const entry2 = history.add_entry('Duplicate content');
		const entry3 = history.add_entry('Duplicate content');

		// Initial check - current content doesn't match any entry
		assert.notInclude(editor_state.content_matching_entry_ids, entry1.id);
		assert.notInclude(editor_state.content_matching_entry_ids, entry2.id);
		assert.notInclude(editor_state.content_matching_entry_ids, entry3.id);

		// Set content to match duplicates
		editor_state.current_content = 'Duplicate content';

		// Verify matching entries are tracked
		assert.include(editor_state.content_matching_entry_ids, entry2.id);
		assert.include(editor_state.content_matching_entry_ids, entry3.id);
		assert.notInclude(editor_state.content_matching_entry_ids, entry1.id);
	});
});

describe('saving history changes', () => {
	test('save_changes persists content and converts unsaved to saved', async () => {
		// Make an edit to create unsaved entry
		editor_state.current_content = 'Content to save';
		assert.ok(editor_state.unsaved_edit_entry_id !== null);

		// Save changes
		await editor_state.save_changes();

		// Verify the unsaved flag was cleared
		assert.isNull(editor_state.unsaved_edit_entry_id);

		// A new entry should be created with correct properties
		const history = app.get_diskfile_history(TEST_PATH)!;
		assert.include(history.entries[0]!, {
			content: 'Content to save',
			is_unsaved_edit: false,
		});

		// Selection should point to the new entry
		assert.strictEqual(editor_state.selected_history_entry_id, history.entries[0]!.id);
	});

	test('save_changes with no changes returns false', async () => {
		// Don't make any changes
		assert.ok(!(editor_state.has_changes));

		// Try to save
		const result = await editor_state.save_changes();

		// Verify nothing was saved
		assert.ok(!(result));
	});

	test('save_changes updates the diskfile content', async () => {
		// Make an edit
		editor_state.current_content = 'New saved content';

		// Save changes
		await editor_state.save_changes();

		// Verify diskfile was updated
		assert.strictEqual(test_diskfile.content, 'New saved content');

		// Verify last_seen_disk_content was updated
		assert.strictEqual(editor_state.last_seen_disk_content, 'New saved content');
	});
});

describe('managing unsaved edits', () => {
	test('multiple unsaved edits can exist simultaneously', () => {
		// Create two base entries
		const history = app.get_diskfile_history(TEST_PATH)!;
		const entry1 = history.add_entry('Base 1');
		const entry2 = history.add_entry('Base 2');

		// Edit first entry
		editor_state.set_content_from_history(entry1.id);
		editor_state.current_content = 'Modified 1';
		const unsaved1_id = editor_state.unsaved_edit_entry_id;

		// Edit second entry
		editor_state.set_content_from_history(entry2.id);
		editor_state.current_content = 'Modified 2';
		const unsaved2_id = editor_state.unsaved_edit_entry_id;

		// Verify both unsaved entries exist
		assert.ok(unsaved1_id !== null);
		assert.ok(unsaved2_id !== null);
		assert.notStrictEqual(unsaved1_id, unsaved2_id);

		// Verify both entries in history
		const unsaved1 = history.find_entry_by_id(unsaved1_id!);
		const unsaved2 = history.find_entry_by_id(unsaved2_id!);

		assert.include(unsaved1, {
			content: 'Modified 1',
			is_unsaved_edit: true,
		});

		assert.include(unsaved2, {
			content: 'Modified 2',
			is_unsaved_edit: true,
		});
	});

	test('clear_unsaved_edits removes all unsaved entries', () => {
		// Create multiple unsaved edits
		const history = app.get_diskfile_history(TEST_PATH)!;

		// Add one through normal editing
		editor_state.current_content = 'Unsaved 1';

		// Add another directly to history
		history.add_entry('Unsaved 2', {is_unsaved_edit: true});

		// Clear unsaved edits
		editor_state.clear_unsaved_edits();

		// Verify all unsaved entries are gone
		const unsaved_after = history.entries.filter((e) => e.is_unsaved_edit);
		assert.strictEqual(unsaved_after.length, 0);

		// Unsaved edit id should be cleared
		assert.isNull(editor_state.unsaved_edit_entry_id);
	});

	test('clear_unsaved_edits updates selection when selected entry is removed', () => {
		// Create an unsaved edit and select it
		editor_state.current_content = 'Unsaved edit';
		const unsaved_id = editor_state.unsaved_edit_entry_id;

		// Verify it's selected
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved_id);

		// Clear unsaved edits
		editor_state.clear_unsaved_edits();

		// Selection should be updated to a valid entry or null
		assert.notStrictEqual(editor_state.selected_history_entry_id, unsaved_id);
	});
});

describe('history clearing', () => {
	test('clear_history removes all but most recent entry', () => {
		// Add multiple entries
		const history = app.get_diskfile_history(TEST_PATH)!;
		history.add_entry('Entry 1');
		history.add_entry('Entry 2');
		const newest = history.add_entry('Newest entry');

		// Clear history
		editor_state.clear_history();

		// Only one entry should remain
		assert.strictEqual(history.entries.length, 1);
		assert.include(history.entries[0], {
			id: newest.id,
			content: 'Newest entry',
			is_original_state: true,
		});

		// Selection should be updated
		assert.strictEqual(editor_state.selected_history_entry_id, newest.id);
		assert.isNull(editor_state.unsaved_edit_entry_id);
	});

	test('clear_history preserves all unsaved edits', () => {
		// Setup history with both saved and unsaved entries
		const history = app.get_diskfile_history(TEST_PATH)!;

		// Add a saved entry
		history.add_entry('Newest entry');

		// Add two unsaved entries
		const unsaved_entry1 = history.add_entry('Unsaved edit 1', {
			is_unsaved_edit: true,
			label: 'Unsaved 1',
		});

		const unsaved_entry2 = history.add_entry('Unsaved edit 2', {
			is_unsaved_edit: true,
			label: 'Unsaved 2',
		});

		// Clear history
		editor_state.clear_history();

		// Verify the specific unsaved entries still exist
		assert.include(history.find_entry_by_id(unsaved_entry1.id), {
			content: 'Unsaved edit 1',
			is_unsaved_edit: true,
			label: 'Unsaved 1',
		});

		assert.include(history.find_entry_by_id(unsaved_entry2.id), {
			content: 'Unsaved edit 2',
			is_unsaved_edit: true,
			label: 'Unsaved 2',
		});

		// Verify the newest non-unsaved entry was also preserved
		const newest_after_clear = history.entries.find((entry) => !entry.is_unsaved_edit);
		assert.include(newest_after_clear, {
			content: 'Newest entry',
			is_original_state: true,
		});

		// Verify the original entry was removed (since it's not the newest saved entry)
		const original_entry = history.entries.find((entry) => entry.content === TEST_CONTENT);
		assert.ok(original_entry === undefined);
	});
});

// @vitest-environment jsdom

import { test, beforeEach, describe, assert } from 'vitest';

import type { DiskfileEditorState } from '$lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';
import { Diskfile } from '$lib/diskfile.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

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
		content: TEST_CONTENT
	});

	// Create the editor state with real components
	editor_state = app.diskfiles.get_editor_state(test_diskfile);
});

describe('unsaved edit creation', () => {
	test('updating content creates an unsaved entry and updates selection', () => {
		// Update content
		const new_content = 'Modified content';
		editor_state.current_content = new_content;

		// Verify an unsaved entry was created
		assert.ok(editor_state.unsaved_edit_entry_id !== null);

		// Verify the new entry
		const history = editor_state.history;
		const new_entry = history.find_entry_by_id(editor_state.unsaved_edit_entry_id);

		assert.include(new_entry, {
			content: new_content,
			is_unsaved_edit: true,
			label: 'Unsaved edit'
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
		const history = editor_state.history;
		const updated_entry = history.find_entry_by_id(unsaved_id);

		assert.include(updated_entry, {
			content: 'Third edit',
			is_unsaved_edit: true
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
		const history = editor_state.history;
		assert.ok(history.find_entry_by_id(unsaved_id!) === undefined);
	});

	test('editing to match an older saved state makes a draft of it', () => {
		const history = editor_state.history;
		const existing_entry = history.add_entry('Existing content');

		editor_state.current_content = 'Existing content';

		// unsaved in this file, so it's the draft (and the tab is marked), not the old entry
		assert.notStrictEqual(editor_state.selected_history_entry_id, existing_entry.id);
		assert.ok(editor_state.unsaved_edit_entry_id);
		assert.strictEqual(editor_state.selected_history_entry_id, editor_state.unsaved_edit_entry_id);
		assert.isTrue(editor_state.dirty);
	});

	test('editing to match a discarded edit makes a draft of it', () => {
		editor_state.current_content = 'D';
		editor_state.discard_draft();

		editor_state.current_content = 'D';

		assert.isTrue(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.selected_history_entry?.is_discarded_edit);
	});

	test('editing to match existing unsaved edit selects that entry', () => {
		// Create an unsaved entry
		const history = editor_state.history;
		const unsaved_entry = history.add_entry('Unsaved content', { is_unsaved_edit: true });

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
		const history = editor_state.history;
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
		const history = editor_state.history;
		const unsaved_entry = history.add_entry('Unsaved content', { is_unsaved_edit: true });

		// Select unsaved entry
		editor_state.set_content_from_history(unsaved_entry.id);

		// Verify both ids are set correctly
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved_entry.id);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_entry.id);
	});

	test('picking a saved entry keeps the draft until the next edit sets it aside', () => {
		const history = editor_state.history;
		const saved_entry = history.add_entry('Saved content');

		editor_state.current_content = 'Unsaved content';
		const draft_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft_id !== null);

		editor_state.set_content_from_history(saved_entry.id);

		// picking changes only what's shown
		assert.strictEqual(editor_state.selected_history_entry_id, saved_entry.id);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, draft_id);
		assert.strictEqual(history.find_entry_by_id(draft_id)?.content, 'Unsaved content');
	});

	test('content_matching_entry_ids tracks entries with matching content', () => {
		// Create entries with duplicate content
		const history = editor_state.history;
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
		const history = editor_state.history;
		assert.include(history.entries[0]!, {
			content: 'Content to save',
			is_unsaved_edit: false
		});

		// Selection should point to the new entry
		assert.strictEqual(editor_state.selected_history_entry_id, history.entries[0]!.id);
	});

	test('save_changes with no changes returns false', async () => {
		// Don't make any changes
		assert.ok(!editor_state.has_changes);

		// Try to save
		const result = await editor_state.save_changes();

		// Verify nothing was saved
		assert.ok(!result);
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
	test('a file keeps one draft: editing from another entry sets the old one aside', () => {
		const history = editor_state.history;
		const entry1 = history.add_entry('Base 1');
		const entry2 = history.add_entry('Base 2');

		editor_state.set_content_from_history(entry1.id);
		editor_state.current_content = 'Modified 1';
		const draft1_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft1_id !== null);

		editor_state.set_content_from_history(entry2.id);
		editor_state.current_content = 'Modified 2';
		const draft2_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft2_id !== null);
		assert.notStrictEqual(draft1_id, draft2_id);

		// one unsaved entry, the other kept as a discarded edit
		assert.strictEqual(editor_state.unsaved_history_entries.length, 1);
		assert.include(history.find_entry_by_id(draft2_id), {
			content: 'Modified 2',
			is_unsaved_edit: true
		});
		assert.include(history.find_entry_by_id(draft1_id), {
			content: 'Modified 1',
			is_unsaved_edit: false,
			is_discarded_edit: true
		});
	});

	test('editing the draft keeps one entry and dates it to the latest edit', async () => {
		editor_state.current_content = 'First';
		const draft = editor_state.history.draft_entry;
		assert.ok(draft);
		const first_created = draft.created;
		await new Promise((resolve) => setTimeout(resolve, 5));

		editor_state.current_content = 'Second';

		assert.strictEqual(editor_state.unsaved_history_entries.length, 1);
		assert.strictEqual(editor_state.history.draft_entry?.id, draft.id);
		assert.isAbove(editor_state.history.draft_entry!.created, first_created);
		assert.strictEqual(editor_state.history.current_entry?.id, draft.id);
	});

	test('clear_unsaved_edits removes all unsaved entries', () => {
		// Create multiple unsaved edits
		const history = editor_state.history;

		// Add one through normal editing
		editor_state.current_content = 'Unsaved 1';

		// Add another directly to history
		history.add_entry('Unsaved 2', { is_unsaved_edit: true });

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
	test('clear_history keeps only the entry for the disk content', () => {
		const history = editor_state.history;
		history.add_entry('Entry 1');
		history.add_entry('Entry 2');
		const newest = history.add_entry('Newest entry');
		editor_state.set_content_from_history(newest.id);

		editor_state.clear_history();

		assert.strictEqual(history.entries.length, 1);
		assert.include(history.entries[0], {
			content: TEST_CONTENT,
			is_original_state: true
		});
		// the removed selection moves to the disk entry
		assert.strictEqual(editor_state.selected_history_entry_id, history.entries[0]!.id);
		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.isNull(editor_state.unsaved_edit_entry_id);
	});

	test('clear_history records the disk content when no saved entry holds it', () => {
		const history = editor_state.history;
		history.entries = [];
		history.add_entry('Entry 1');
		history.add_entry('Newest entry');

		editor_state.clear_history();

		assert.strictEqual(history.entries.length, 1);
		assert.include(history.entries[0], { content: TEST_CONTENT, is_original_state: true });
		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.isFalse(editor_state.dirty);
	});

	test('saving a picked discarded edit records a saved state that clear_history keeps', async () => {
		editor_state.current_content = 'mine';
		const draft_id = editor_state.unsaved_edit_entry_id!;
		editor_state.discard_draft(); // "reload from disk"
		editor_state.set_content_from_history(draft_id); // pick the discarded text back
		assert.ok(await editor_state.save_changes());
		assert.strictEqual(test_diskfile.content, 'mine');

		// the save is a real saved state, not the discarded entry
		const shown = editor_state.selected_history_entry!;
		assert.notStrictEqual(shown.id, draft_id);
		assert.include(shown, { content: 'mine', is_unsaved_edit: false, is_discarded_edit: false });
		assert.include(editor_state.history.find_entry_by_id(draft_id), { is_discarded_edit: true });
		assert.isFalse(editor_state.dirty);

		editor_state.clear_history();

		assert.strictEqual(editor_state.current_content, 'mine');
		assert.isFalse(editor_state.dirty);
		assert.isFalse(editor_state.can_save, 'a save would not revert the disk');
		assert.deepEqual(
			editor_state.history.entries.map((entry) => [entry.content, entry.is_original_state]),
			[['mine', true]]
		);
	});

	test('saving a picked discarded edit records a saved state when an external write merges with it', async () => {
		let finish_write!: (result: { ok: true; value: null }) => void;
		app.diskfiles.update = () =>
			new Promise((resolve) => {
				finish_write = resolve;
			});
		editor_state.current_content = 'mine';
		const draft_id = editor_state.unsaved_edit_entry_id!;
		editor_state.discard_draft();
		editor_state.set_content_from_history(draft_id);

		const saving = editor_state.save_changes();
		// the filer's debounce merged the save's change and an external write into one
		test_diskfile.content = 'external';
		editor_state.check_disk_changes();
		finish_write({ ok: true, value: null });
		assert.ok(await saving);

		const saved = editor_state.history.entries.filter(
			(entry) => entry.content === 'mine' && !entry.is_unsaved_edit && !entry.is_discarded_edit
		);
		assert.strictEqual(saved.length, 1, 'the save is recorded as a saved state');
		assert.include(editor_state.history.find_entry_by_id(draft_id), { is_discarded_edit: true });
	});

	test('clear_history never falls back to a stale saved state', () => {
		// the disk moved on while its entry was missing from the history
		const history = editor_state.history;
		history.entries = [];
		const stale = history.add_entry('stale');
		editor_state.set_content_from_history(stale.id);
		history.add_entry('a discarded edit', { is_discarded_edit: true });

		editor_state.clear_history();

		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.isFalse(editor_state.dirty);
		assert.isUndefined(history.find_entry_by_id(stale.id));
	});

	test('clear_history preserves the unsaved edits', () => {
		const history = editor_state.history;
		history.add_entry('Newest entry');
		const unsaved_entry1 = history.add_entry('Unsaved edit 1', {
			is_unsaved_edit: true,
			label: 'Unsaved 1'
		});
		const unsaved_entry2 = history.add_entry('Unsaved edit 2', {
			is_unsaved_edit: true,
			label: 'Unsaved 2'
		});

		editor_state.clear_history();

		assert.include(history.find_entry_by_id(unsaved_entry1.id), {
			content: 'Unsaved edit 1',
			is_unsaved_edit: true
		});
		assert.include(history.find_entry_by_id(unsaved_entry2.id), {
			content: 'Unsaved edit 2',
			is_unsaved_edit: true
		});
		const saved_after_clear = history.entries.filter((entry) => !entry.is_unsaved_edit);
		assert.strictEqual(saved_after_clear.length, 1);
		assert.include(saved_after_clear[0], { content: TEST_CONTENT, is_original_state: true });
	});
});

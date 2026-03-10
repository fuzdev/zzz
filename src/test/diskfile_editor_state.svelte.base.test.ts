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

describe('initialization', () => {
	test('editor_state initializes with correct values', () => {
		assert.strictEqual(editor_state.original_content, TEST_CONTENT);
		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.ok(!editor_state.has_changes);
		assert.ok(!editor_state.content_was_modified_by_user);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		assert.strictEqual(editor_state.last_seen_disk_content, TEST_CONTENT);

		// Selected history entry should be initialized to the current entry
		const history = app.get_diskfile_history(TEST_PATH);
		assert.isDefined(history);
		assert.strictEqual(history!.entries.length, 1);
		assert.strictEqual(editor_state.selected_history_entry_id, history!.entries[0]!.id);
		assert.strictEqual(history!.entries[0]!.content, TEST_CONTENT);
	});

	test('editor_state initializes with correct history entry', () => {
		const history = app.get_diskfile_history(TEST_PATH);
		assert.isDefined(history);
		assert.strictEqual(history!.entries.length, 1);

		// The initial entry should contain the original content
		assert.strictEqual(history!.entries[0]!.content, TEST_CONTENT);
		assert.ok(!history!.entries[0]!.is_unsaved_edit);
		assert.ok(!history!.entries[0]!.is_disk_change);
		assert.ok(history!.entries[0]!.is_original_state);
	});

	test('editor_state handles initialization with null content', () => {
		// Create a diskfile with null content
		const null_diskfile = app.diskfiles.add({
			path: DiskfilePath.parse('/null/content.txt'),
			source_dir: SerializableDisknode.shape.source_dir.parse('/null/'),
			content: null,
		});

		// Create editor state
		const null_editor_state = new DiskfileEditorState({
			app,
			diskfile: null_diskfile,
		});

		// Check state properties
		assert.isNull(null_editor_state.original_content);
		assert.strictEqual(null_editor_state.current_content, '');
		assert.ok(!null_editor_state.has_changes);
		assert.isNull(null_editor_state.last_seen_disk_content);

		// History should still be created
		const history = app.get_diskfile_history(null_diskfile.path);
		assert.isDefined(history);
		assert.strictEqual(history!.entries.length, 0); // No entries for null content
	});
});

describe('content editing', () => {
	test('updating content updates editor state', () => {
		const new_content = 'Modified content';
		editor_state.current_content = new_content;

		assert.strictEqual(editor_state.current_content, new_content);
		assert.ok(editor_state.has_changes);
		assert.ok(editor_state.content_was_modified_by_user);
	});

	test('content modifications track user edits flag', () => {
		// Initial state - no user edits
		assert.ok(!editor_state.content_was_modified_by_user);

		// Change content - should mark as user-edited
		editor_state.current_content = 'User edit';
		assert.ok(editor_state.content_was_modified_by_user);

		// Change back to original - should clear user-edited flag
		editor_state.current_content = TEST_CONTENT;
		assert.ok(!editor_state.content_was_modified_by_user);
	});

	test('has_changes tracks difference between current and original content', () => {
		// Initial state - no changes
		assert.ok(!editor_state.has_changes);

		// Make a change
		editor_state.current_content = 'Changed content';
		assert.ok(editor_state.has_changes);

		// Change back to original
		editor_state.current_content = TEST_CONTENT;
		assert.ok(!editor_state.has_changes);
	});

	test('editing content preserves selection state', () => {
		// First make an edit to create history entries
		editor_state.current_content = 'First edit';
		const history = app.get_diskfile_history(TEST_PATH)!;

		// Get the selected entry id
		const selected_id = editor_state.selected_history_entry_id;
		assert.ok(selected_id !== null);

		// Make another edit
		editor_state.current_content = 'Second edit';

		// Selection should still be active
		assert.ok(editor_state.selected_history_entry_id !== null);

		// Content should be updated in the selected entry
		const updated_entry = history.find_entry_by_id(editor_state.selected_history_entry_id!);
		assert.isDefined(updated_entry);
		assert.strictEqual(updated_entry!.content, 'Second edit');
	});

	test('editing to match original content clears user modified flag', () => {
		// Make an edit
		editor_state.current_content = 'User edit';
		assert.ok(editor_state.content_was_modified_by_user);
		assert.ok(editor_state.has_changes);

		// Edit back to match original
		editor_state.current_content = TEST_CONTENT;

		// Flags should be cleared
		assert.ok(!editor_state.content_was_modified_by_user);
		assert.ok(!editor_state.has_changes);
	});
});

describe('content metrics', () => {
	test('editor provides accurate content length metrics', () => {
		// Initial length
		assert.strictEqual(editor_state.original_length, TEST_CONTENT.length);
		assert.strictEqual(editor_state.current_length, TEST_CONTENT.length);
		assert.strictEqual(editor_state.length_diff, 0);
		assert.strictEqual(editor_state.length_diff_percent, 0);

		// Update content
		const new_content = 'Shorter';
		editor_state.current_content = new_content;

		// Check metrics
		assert.strictEqual(editor_state.current_length, new_content.length);
		assert.strictEqual(editor_state.length_diff, new_content.length - TEST_CONTENT.length);

		// Percent change should be negative
		const expected_percent = Math.round(
			((new_content.length - TEST_CONTENT.length) / TEST_CONTENT.length) * 100,
		);
		assert.strictEqual(editor_state.length_diff_percent, expected_percent);
	});

	test('editor provides accurate token metrics', () => {
		// Set specific content to test tokens
		const token_test_content = 'This is a test with multiple tokens.';
		editor_state.current_content = token_test_content;

		// Verify token calculations
		assert.ok(editor_state.current_token_count > 0);
		assert.strictEqual(editor_state.current_token_count, editor_state.current_token_count);
		assert.strictEqual(
			editor_state.token_diff,
			editor_state.current_token_count - editor_state.original_token_count,
		);

		// Token percent should match calculation
		const expected_token_percent = Math.round(
			((editor_state.current_token_count - editor_state.original_token_count) /
				editor_state.original_token_count) *
				100,
		);
		assert.strictEqual(editor_state.token_diff_percent, expected_token_percent);
	});

	test('editor handles metrics for empty content', () => {
		// Change to empty content
		editor_state.current_content = '';

		// Check length metrics
		assert.strictEqual(editor_state.current_length, 0);
		assert.strictEqual(editor_state.length_diff, -TEST_CONTENT.length);
		assert.strictEqual(editor_state.length_diff_percent, -100);

		// Check token metrics
		assert.strictEqual(editor_state.current_token_count, 0);
		assert.strictEqual(editor_state.current_token_count, 0);
		assert.strictEqual(editor_state.token_diff, -editor_state.original_token_count);
		assert.strictEqual(editor_state.token_diff_percent, -100);
	});

	test('length_diff_percent handles zero original length correctly', () => {
		// Create a diskfile with empty content
		const empty_diskfile = app.diskfiles.add({
			path: DiskfilePath.parse('/empty/file.txt'),
			source_dir: SerializableDisknode.shape.source_dir.parse('/empty/'),
			content: '',
		});

		// Create editor state
		const empty_editor_state = new DiskfileEditorState({
			app,
			diskfile: empty_diskfile,
		});

		// Now edit to add content
		empty_editor_state.current_content = 'New content';

		// Since original length was 0, percentage should be 100%
		assert.strictEqual(empty_editor_state.original_length, 0);
		assert.strictEqual(empty_editor_state.length_diff_percent, 100);

		// Same for tokens
		assert.strictEqual(empty_editor_state.original_token_count, 0);
		assert.strictEqual(empty_editor_state.token_diff_percent, 100);
	});
});

describe('file management', () => {
	test('update_diskfile handles switching to different file', () => {
		// Create another diskfile
		const another_path = DiskfilePath.parse('/different/file.txt');
		const another_content = 'Different file content';
		const another_diskfile = app.diskfiles.add({
			path: another_path,
			source_dir: SerializableDisknode.shape.source_dir.parse('/different/'),
			content: another_content,
		});

		// Make edits to the current file
		editor_state.current_content = 'Edited original file';

		// Switch to the new file
		editor_state.update_diskfile(another_diskfile);

		// Verify state was properly updated
		assert.strictEqual(editor_state.diskfile, another_diskfile);
		assert.strictEqual(editor_state.original_content, another_content);
		assert.strictEqual(editor_state.current_content, another_content);
		assert.ok(!editor_state.has_changes);
		assert.ok(!editor_state.content_was_modified_by_user);

		// History should be initialized for the new file
		const new_history = app.get_diskfile_history(another_path);
		assert.isDefined(new_history);
		assert.strictEqual(new_history!.entries.length, 1);
		assert.strictEqual(new_history!.entries[0]!.content, another_content);
	});

	test('update_diskfile does nothing when same diskfile is provided', () => {
		// Make some edits
		editor_state.current_content = 'Edited content';

		// Track current state
		const current_content = editor_state.current_content;
		const current_modified = editor_state.content_was_modified_by_user;

		// Call update with the same diskfile
		editor_state.update_diskfile(test_diskfile);

		// State should remain unchanged
		assert.strictEqual(editor_state.current_content, current_content);
		assert.strictEqual(editor_state.content_was_modified_by_user, current_modified);
	});

	test('reset clears editor state and reverts to original content', () => {
		// Make edits
		editor_state.current_content = 'Edited content';

		// Create and select unsaved entry
		const history = app.get_diskfile_history(TEST_PATH)!;
		const test_entry = history.add_entry('Test entry', {is_unsaved_edit: true});
		editor_state.set_content_from_history(test_entry.id);

		// Reset the editor
		editor_state.reset();

		// Verify state is reset
		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.ok(!editor_state.has_changes);
		assert.ok(!editor_state.content_was_modified_by_user);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		assert.isNull(editor_state.selected_history_entry_id);
	});
});

describe('derived state', () => {
	test('derived property has_history is accurate', () => {
		// Initial state - only one entry, should not have history
		assert.ok(!editor_state.has_history);

		// Add an entry
		editor_state.current_content = 'New content';

		// Now we should have history
		assert.ok(editor_state.has_history);
	});

	test('derived property has_unsaved_edits is accurate', async () => {
		// Initial state - no unsaved edits
		assert.ok(!editor_state.has_unsaved_edits);

		// Make an edit
		editor_state.current_content = 'Unsaved edit';

		// Now we should have unsaved edits
		assert.ok(editor_state.has_unsaved_edits);

		// Save the changes
		await editor_state.save_changes();

		// No more unsaved edits
		assert.ok(!editor_state.has_unsaved_edits);
	});

	test('derived properties for UI state management', () => {
		// Initial state
		assert.ok(!editor_state.can_clear_history);
		assert.ok(!editor_state.can_clear_unsaved_edits);

		// Add a saved entry
		const history = app.get_diskfile_history(TEST_PATH)!;
		history.add_entry('Saved entry 1');
		history.add_entry('Saved entry 2');

		// Now we can clear history
		assert.ok(editor_state.can_clear_history);

		// Add an unsaved entry
		editor_state.current_content = 'Unsaved edit';

		// Now we can clear unsaved edits as well
		assert.ok(editor_state.can_clear_unsaved_edits);
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

describe('saving changes', () => {
	test('save_changes persists content to diskfile', async () => {
		// Make an edit
		editor_state.current_content = 'Content to save';

		// Save changes
		const result = await editor_state.save_changes();

		// Verify result and diskfile update
		assert.ok(result);
		assert.strictEqual(test_diskfile.content, 'Content to save');
		assert.strictEqual(editor_state.last_seen_disk_content, 'Content to save');
		assert.ok(!editor_state.content_was_modified_by_user);
	});

	test('save_changes with no changes returns false', async () => {
		// Don't make any changes
		assert.ok(!editor_state.has_changes);

		// Try to save
		const result = await editor_state.save_changes();

		// Verify nothing was saved
		assert.ok(!result);
	});

	test('save_changes creates history entry with correct properties', async () => {
		// Make an edit
		editor_state.current_content = 'Content to be saved';

		// Save changes
		await editor_state.save_changes();

		// Check history entry
		const history = app.get_diskfile_history(TEST_PATH)!;
		assert.strictEqual(history.entries[0]!.content, 'Content to be saved');
		assert.ok(!history.entries[0]!.is_unsaved_edit);
		assert.ok(!history.entries[0]!.is_disk_change);
	});
});

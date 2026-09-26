// @vitest-environment jsdom

import { test, beforeEach, describe, assert, vi } from 'vitest';

import type { DiskfileEditorState } from '$lib/diskfile_editor_state.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';
import { Diskfile } from '$lib/diskfile.svelte.ts';

import { create_deferred } from '@fuzdev/fuz_util/async.ts';

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

describe('initialization', () => {
	test('editor_state initializes with correct values', () => {
		assert.strictEqual(editor_state.original_content, TEST_CONTENT);
		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.ok(!editor_state.has_changes);
		assert.ok(!editor_state.content_was_modified_by_user);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		assert.strictEqual(editor_state.last_seen_disk_content, TEST_CONTENT);

		// Selected history entry should be initialized to the current entry
		const history = editor_state.history;
		assert.isDefined(history);
		assert.strictEqual(history.entries.length, 1);
		assert.strictEqual(editor_state.selected_history_entry_id, history.entries[0]!.id);
		assert.strictEqual(history.entries[0]!.content, TEST_CONTENT);
	});

	test('editor_state initializes with correct history entry', () => {
		const history = editor_state.history;
		assert.isDefined(history);
		assert.strictEqual(history.entries.length, 1);

		// The initial entry should contain the original content
		assert.strictEqual(history.entries[0]!.content, TEST_CONTENT);
		assert.ok(!history.entries[0]!.is_unsaved_edit);
		assert.ok(!history.entries[0]!.is_disk_change);
		assert.ok(history.entries[0]!.is_original_state);
	});

	test('editor_state handles initialization with null content', () => {
		// Create a diskfile with null content
		const null_diskfile = app.diskfiles.add({
			path: DiskfilePath.parse('/null/content.txt'),
			source_dir: SerializableDisknode.shape.source_dir.parse('/null/'),
			content: null
		});

		// Create editor state
		const null_editor_state = app.diskfiles.get_editor_state(null_diskfile);

		// Check state properties
		assert.isNull(null_editor_state.original_content);
		assert.strictEqual(null_editor_state.current_content, '');
		assert.ok(!null_editor_state.has_changes);
		assert.ok(!null_editor_state.content_loaded, 'read-only, see the content_not_loaded suite');
		assert.isNull(null_editor_state.last_seen_disk_content);

		// History should still be created
		const { history } = null_editor_state;
		assert.isDefined(history);
		assert.strictEqual(history.entries.length, 0); // No entries for null content
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
		const history = editor_state.history;

		// Get the selected entry id
		const selected_id = editor_state.selected_history_entry_id;
		assert.ok(selected_id !== null);

		// Make another edit
		editor_state.current_content = 'Second edit';

		// Selection should still be active
		assert.ok(editor_state.selected_history_entry_id !== null);

		// Content should be updated in the selected entry
		const updated_entry = history.find_entry_by_id(editor_state.selected_history_entry_id);
		assert.isDefined(updated_entry);
		assert.strictEqual(updated_entry.content, 'Second edit');
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
			((new_content.length - TEST_CONTENT.length) / TEST_CONTENT.length) * 100
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
			editor_state.current_token_count - editor_state.original_token_count
		);

		// Token percent should match calculation
		const expected_token_percent = Math.round(
			((editor_state.current_token_count - editor_state.original_token_count) /
				editor_state.original_token_count) *
				100
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
			content: ''
		});

		// Create editor state
		const empty_editor_state = app.diskfiles.get_editor_state(empty_diskfile);

		// Now edit to add content
		empty_editor_state.current_content = 'New content';

		// Since original length was 0, percentage should be 100%
		assert.strictEqual(empty_editor_state.original_length, 0);
		assert.strictEqual(empty_editor_state.length_diff_percent, 100);

		// Same for tokens
		assert.strictEqual(empty_editor_state.original_token_count, 0);
		assert.strictEqual(empty_editor_state.token_diff_percent, 100);
	});

	test('diff percents are 0 when an empty original is unchanged', () => {
		const empty_diskfile = app.diskfiles.add({
			path: DiskfilePath.parse('/empty/unchanged.txt'),
			source_dir: SerializableDisknode.shape.source_dir.parse('/empty/'),
			content: ''
		});
		const empty_editor_state = app.diskfiles.get_editor_state(empty_diskfile);

		assert.strictEqual(empty_editor_state.length_diff, 0);
		assert.strictEqual(empty_editor_state.length_diff_percent, 0);
		assert.strictEqual(empty_editor_state.token_diff, 0);
		assert.strictEqual(empty_editor_state.token_diff_percent, 0);

		// back to empty after an edit
		empty_editor_state.current_content = 'x';
		empty_editor_state.current_content = '';
		assert.strictEqual(empty_editor_state.length_diff_percent, 0);
		assert.strictEqual(empty_editor_state.token_diff_percent, 0);
	});
});

describe('file management', () => {
	test('each file has its own editing state, kept while another is shown', () => {
		const another_path = DiskfilePath.parse('/different/file.txt');
		const another_content = 'Different file content';
		const another_diskfile = app.diskfiles.add({
			path: another_path,
			source_dir: SerializableDisknode.shape.source_dir.parse('/different/'),
			content: another_content
		});

		editor_state.current_content = 'Edited original file';

		const another_state = app.diskfiles.get_editor_state(another_diskfile);
		assert.notStrictEqual(another_state, editor_state);
		assert.strictEqual(another_state.diskfile, another_diskfile);
		assert.strictEqual(another_state.current_content, another_content);
		assert.isFalse(another_state.has_changes);
		assert.strictEqual(another_state.history.entries.length, 1);
		assert.strictEqual(another_state.history.entries[0]!.content, another_content);

		// the first file's draft is untouched
		assert.strictEqual(editor_state.current_content, 'Edited original file');
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.isTrue(editor_state.has_unsaved_edits);
	});

	test('get_editor_state returns the same state for a file', () => {
		editor_state.current_content = 'Edited content';
		const again = app.diskfiles.get_editor_state(test_diskfile);
		assert.strictEqual(again, editor_state);
		assert.strictEqual(app.diskfiles.find_editor_state(test_diskfile.id), editor_state);
		assert.strictEqual(again.current_content, 'Edited content');
	});

	test('discard_draft shows the disk content and sets the draft aside', () => {
		editor_state.current_content = 'Edited content';
		const draft_id = editor_state.unsaved_edit_entry_id;
		assert.ok(draft_id);

		editor_state.discard_draft();

		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.isFalse(editor_state.has_changes);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		// the draft's text stays restorable
		const set_aside = editor_state.history.find_entry_by_id(draft_id);
		assert.ok(set_aside);
		assert.include(set_aside, {
			content: 'Edited content',
			is_unsaved_edit: false,
			is_discarded_edit: true
		});
	});

	test('reset_view shows the draft if there is one, else the disk content', () => {
		const history = editor_state.history;
		const older = history.add_entry('older', { created: 1 });
		editor_state.set_content_from_history(older.id);
		assert.isTrue(editor_state.has_changes);
		editor_state.save_error = 'stale';

		editor_state.reset_view();

		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.isNull(editor_state.save_error);

		editor_state.current_content = 'draft';
		const original = history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.set_content_from_history(original.id);

		editor_state.reset_view();

		assert.strictEqual(editor_state.current_content, 'draft');
		assert.isTrue(editor_state.content_was_modified_by_user);
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
		const history = editor_state.history;
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
		const history = editor_state.history;
		assert.strictEqual(history.entries[0]!.content, 'Content to be saved');
		assert.ok(!history.entries[0]!.is_unsaved_edit);
		assert.ok(!history.entries[0]!.is_disk_change);
	});
});

describe('saving failures and concurrent edits', () => {
	const ERROR = { code: -32603, message: 'disk full' } as const;

	/** Makes `app.diskfiles.update` wait for the returned deferred. */
	const defer_update = () => {
		const writes: Array<string> = [];
		const deferred = create_deferred<Awaited<ReturnType<Frontend['diskfiles']['update']>>>();
		app.diskfiles.update = (_path, content) => {
			writes.push(content);
			return deferred.promise;
		};
		return { writes, deferred };
	};

	test('a failed save leaves the edit unsaved and sets save_error', async () => {
		editor_state.current_content = 'edited';
		const history = editor_state.history;
		const entries_before = history.entries.map((entry) => ({ ...entry }));
		const unsaved_id = editor_state.unsaved_edit_entry_id;
		assert.isNotNull(unsaved_id);
		app.diskfiles.update = () => Promise.resolve({ ok: false, error: ERROR });

		const result = await editor_state.save_changes();

		assert.isFalse(result);
		assert.strictEqual(editor_state.save_error, 'disk full');
		assert.isFalse(editor_state.saving);
		assert.deepEqual(history.entries, entries_before);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_id);
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved_id);
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.strictEqual(editor_state.last_seen_disk_content, TEST_CONTENT);
		assert.strictEqual(editor_state.current_content, 'edited');
		assert.isTrue(editor_state.has_unsaved_edits);
	});

	test('a thrown write reports save_error and leaves the edit unsaved', async () => {
		editor_state.current_content = 'edited';
		const history = editor_state.history;
		const entries_before = history.entries.map((entry) => ({ ...entry }));
		const unsaved_id = editor_state.unsaved_edit_entry_id;
		app.diskfiles.update = () => Promise.reject(new Error('socket closed'));

		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			assert.isFalse(await editor_state.save_changes());
			assert.strictEqual(error_spy.mock.calls.length, 1);
		} finally {
			error_spy.mockRestore();
		}

		assert.strictEqual(editor_state.save_error, 'socket closed');
		assert.isFalse(editor_state.saving);
		assert.deepEqual(history.entries, entries_before);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_id);
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.strictEqual(editor_state.last_seen_disk_content, TEST_CONTENT);

		monkeypatch_zzz_for_tests(app);
		assert.isTrue(await editor_state.save_changes());
		assert.isNull(editor_state.save_error);
	});

	test('a synchronously thrown write does not lock saving', async () => {
		editor_state.current_content = 'edited';
		app.diskfiles.update = () => {
			throw new Error('not connected');
		};
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			assert.isFalse(await editor_state.save_changes());
			assert.strictEqual(error_spy.mock.calls.length, 1);
		} finally {
			error_spy.mockRestore();
		}
		assert.strictEqual(editor_state.save_error, 'not connected');
		assert.isFalse(editor_state.saving);

		// the next save runs rather than queueing behind a phantom write
		monkeypatch_zzz_for_tests(app);
		assert.isTrue(await editor_state.save_changes());
		assert.strictEqual(test_diskfile.content, 'edited');
		assert.isNull(editor_state.save_error);
		assert.isFalse(editor_state.has_unsaved_edits);
	});

	test('a successful save clears the previous save_error', async () => {
		editor_state.current_content = 'edited';
		app.diskfiles.update = () => Promise.resolve({ ok: false, error: ERROR });
		await editor_state.save_changes();
		assert.strictEqual(editor_state.save_error, 'disk full');

		monkeypatch_zzz_for_tests(app);
		assert.isTrue(await editor_state.save_changes());

		assert.isNull(editor_state.save_error);
	});

	test('saving is true only while the write is in flight', async () => {
		editor_state.current_content = 'edited';
		const { deferred } = defer_update();

		const saving = editor_state.save_changes();
		assert.isTrue(editor_state.saving);

		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
		assert.isFalse(editor_state.saving);
	});

	test('typing while a save is in flight is not reverted', async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		editor_state.current_content = 'first, then more';
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		assert.deepEqual(writes, ['first']);
		assert.strictEqual(editor_state.current_content, 'first, then more');
		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.strictEqual(editor_state.last_seen_disk_content, 'first');

		const history = editor_state.history;
		// the saved content is recorded, the newer edit stays the live unsaved entry
		const saved = history.entries.find((entry) => entry.content === 'first');
		assert.ok(saved);
		assert.isFalse(saved.is_unsaved_edit);
		const unsaved = history.entries.filter((entry) => entry.is_unsaved_edit);
		assert.strictEqual(unsaved.length, 1);
		assert.strictEqual(unsaved[0]!.content, 'first, then more');
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved[0]!.id);
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved[0]!.id);

		// further typing keeps updating that entry rather than adding more
		editor_state.current_content = 'first, then even more';
		assert.strictEqual(history.entries.filter((entry) => entry.is_unsaved_edit).length, 1);
	});

	test('a save with no edits while in flight still settles to the saved entry', async () => {
		editor_state.current_content = 'saved';
		const { deferred } = defer_update();

		const saving = editor_state.save_changes();
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		const history = editor_state.history;
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		assert.strictEqual(history.entries[0]!.content, 'saved');
		assert.strictEqual(editor_state.selected_history_entry_id, history.entries[0]!.id);
		assert.isFalse(editor_state.content_was_modified_by_user);
	});

	test('saving while a save is in flight queues one follow-up save', async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		editor_state.current_content = 'second';
		const queued = editor_state.save_changes();
		editor_state.current_content = 'third';
		// repeat saves share the one follow-up
		const queued_again = editor_state.save_changes();
		assert.isTrue(editor_state.saving);
		assert.deepEqual(writes, ['first']);

		monkeypatch_zzz_for_tests(app);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
		assert.isTrue(await queued);
		assert.isTrue(await queued_again);

		// the follow-up writes what the editor holds once the first settles
		assert.deepEqual(writes, ['first']);
		assert.strictEqual(test_diskfile.content, 'third');
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isFalse(editor_state.saving);
	});

	test('a queued follow-up save is skipped when the in-flight save fails', async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		editor_state.current_content = 'second';
		const queued = editor_state.save_changes();
		deferred.resolve({ ok: false, error: ERROR });

		assert.isFalse(await saving);
		assert.isFalse(await queued);
		assert.deepEqual(writes, ['first']);
		assert.strictEqual(editor_state.save_error, 'disk full');
		assert.strictEqual(test_diskfile.content, TEST_CONTENT);
	});

	test('a thrown write sets save_error, skips the queued follow-up, and later saves work', async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		editor_state.current_content = 'second';
		const queued = editor_state.save_changes();
		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			deferred.reject(new Error('transport closed'));

			// a thrown write is a failed save, not a rejection
			assert.isFalse(await saving);
			assert.isFalse(await queued);
		} finally {
			error_spy.mockRestore();
		}
		assert.isFalse(editor_state.saving);
		assert.strictEqual(editor_state.save_error, 'transport closed');
		assert.deepEqual(writes, ['first']);
		// the edit stays unsaved
		assert.isTrue(editor_state.has_unsaved_edits);
		assert.strictEqual(editor_state.current_content, 'second');

		// later saves run normally, and queue again behind an in-flight one
		const next = defer_update();
		const retry = editor_state.save_changes();
		editor_state.current_content = 'third';
		const queued_again = editor_state.save_changes();
		monkeypatch_zzz_for_tests(app);
		next.deferred.resolve({ ok: true, value: null });
		assert.isTrue(await retry);
		assert.isTrue(await queued_again);
		assert.deepEqual(next.writes, ['second']);
		assert.strictEqual(test_diskfile.content, 'third');
		assert.isFalse(editor_state.has_unsaved_edits);
	});

	test('a queued follow-up with nothing new to write reports the in-flight save', async () => {
		editor_state.current_content = 'first';
		const { writes, deferred } = defer_update();

		const saving = editor_state.save_changes();
		const queued = editor_state.save_changes();
		deferred.resolve({ ok: true, value: null });

		assert.isTrue(await saving);
		assert.isTrue(await queued);
		assert.deepEqual(writes, ['first']);
	});

	test('picking another entry while a save is in flight records the save as saved', async () => {
		const history = editor_state.history;
		const original = history.entries.find((entry) => entry.is_original_state);
		assert.ok(original);
		editor_state.current_content = 'saved';
		const { deferred } = defer_update();

		const saving = editor_state.save_changes();
		editor_state.set_content_from_history(original.id);
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		// the editor stays on the picked entry
		assert.strictEqual(editor_state.selected_history_entry_id, original.id);
		assert.strictEqual(editor_state.current_content, TEST_CONTENT);
		// the saved content is a saved entry, and no unsaved edit lingers
		const saved = history.entries.filter((entry) => entry.content === 'saved');
		assert.strictEqual(saved.length, 1);
		assert.isFalse(saved[0]!.is_unsaved_edit);
		assert.isFalse(history.has_unsaved_edits);
		assert.isNull(editor_state.unsaved_edit_entry_id);
	});

	test('an external edit landing after the save broadcast keeps the disk state', async () => {
		editor_state.current_content = 'saved';
		const history = editor_state.history;
		const { deferred } = defer_update();

		const saving = editor_state.save_changes();
		// the save's own broadcast, then an external edit's, then the response
		test_diskfile.content = 'saved';
		editor_state.check_disk_changes();
		test_diskfile.content = 'external';
		editor_state.check_disk_changes();
		const external = history.entries.find((entry) => entry.content === 'external');
		assert.ok(external);
		const selected_before = editor_state.selected_history_entry_id;
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		assert.strictEqual(editor_state.last_seen_disk_content, 'external');
		assert.strictEqual(history.entries[0], external);
		assert.strictEqual(history.entries.filter((entry) => entry.content === 'saved').length, 1);
		assert.strictEqual(editor_state.selected_history_entry_id, selected_before);
	});

	test('an external edit landing mid-save, then the save broadcast after the response, settles', async () => {
		editor_state.current_content = 'saved';
		const history = editor_state.history;
		const { deferred } = defer_update();

		const saving = editor_state.save_changes();
		// an external write lands just before ours, its broadcast arrives mid-save
		test_diskfile.content = 'external';
		editor_state.check_disk_changes();
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);
		// the editor still shows the edit — the disk holds the external write
		assert.isTrue(editor_state.has_changes);
		assert.isTrue(editor_state.content_was_modified_by_user);

		// our write's broadcast lands after the response
		test_diskfile.content = 'saved';
		editor_state.check_disk_changes();

		assert.isFalse(editor_state.has_changes);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		assert.strictEqual(editor_state.last_seen_disk_content, 'saved');
		assert.strictEqual(editor_state.current_content, 'saved');
		const selected = editor_state.selected_history_entry;
		assert.ok(selected);
		assert.isFalse(selected.is_unsaved_edit);
		assert.strictEqual(selected.content, 'saved');
		assert.ok(history.entries.some((entry) => entry.content === 'external'));
	});

	test('a disk change matching an unsaved edit settles the editor', () => {
		editor_state.current_content = 'same';
		assert.isTrue(editor_state.has_unsaved_edits);

		// another client writes the same content
		test_diskfile.content = 'same';
		editor_state.check_disk_changes();

		assert.isFalse(editor_state.has_changes);
		assert.isFalse(editor_state.content_was_modified_by_user);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.isNull(editor_state.unsaved_edit_entry_id);
		assert.strictEqual(editor_state.selected_history_entry?.content, 'same');
	});

	test('a disk change that differs from the edit leaves it unsaved', () => {
		editor_state.current_content = 'mine';
		const unsaved_id = editor_state.unsaved_edit_entry_id;

		test_diskfile.content = 'theirs';
		editor_state.check_disk_changes();

		assert.isTrue(editor_state.content_was_modified_by_user);
		assert.strictEqual(editor_state.unsaved_edit_entry_id, unsaved_id);
		assert.strictEqual(editor_state.selected_history_entry_id, unsaved_id);
		assert.strictEqual(editor_state.current_content, 'mine');
	});

	describe('another file while a save is in flight', () => {
		const OTHER_PATH = DiskfilePath.parse('/path/to/other.txt');

		const setup_other = () => {
			const other = app.diskfiles.add({
				path: OTHER_PATH,
				source_dir: TEST_DIR,
				content: 'other'
			});
			editor_state.current_content = 'edited';
			const { writes, deferred } = defer_update();
			const saving = editor_state.save_changes();
			const other_state = app.diskfiles.get_editor_state(other);
			const other_entries_before = other_state.history.entries.map((entry) => ({ ...entry }));
			return { other_state, other_entries_before, writes, deferred, saving };
		};

		test('a successful save settles the saved file only', async () => {
			const { other_state, other_entries_before, deferred, saving } = setup_other();

			deferred.resolve({ ok: true, value: null });
			assert.isTrue(await saving);

			// the saved file's history holds the save, with no lingering unsaved edit
			const saved = editor_state.history.entries.filter((entry) => entry.content === 'edited');
			assert.strictEqual(saved.length, 1);
			assert.isFalse(saved[0]!.is_unsaved_edit);
			assert.isFalse(editor_state.has_unsaved_edits);
			assert.strictEqual(editor_state.current_content, 'edited');
			// the other file is untouched
			assert.deepEqual(other_state.history.entries, other_entries_before);
			assert.strictEqual(other_state.current_content, 'other');
			assert.isFalse(other_state.content_was_modified_by_user);
			assert.isNull(other_state.save_error);
		});

		test('a failed save leaves the saved file unsaved and shows nothing on the other', async () => {
			const { other_state, other_entries_before, deferred, saving } = setup_other();

			deferred.resolve({ ok: false, error: ERROR });
			assert.isFalse(await saving);

			assert.isTrue(editor_state.has_unsaved_edits);
			assert.strictEqual(editor_state.save_error, 'disk full');
			assert.deepEqual(other_state.history.entries, other_entries_before);
			assert.isNull(other_state.save_error);
		});

		test('the other file can save while the first is in flight', async () => {
			const { other_state, writes, deferred, saving } = setup_other();
			assert.isTrue(editor_state.saving);
			assert.isFalse(other_state.saving);

			other_state.current_content = 'other edited';
			const saving_other = other_state.save_changes();
			assert.isTrue(other_state.saving);
			deferred.resolve({ ok: true, value: null });
			assert.isTrue(await saving);
			assert.isTrue(await saving_other);

			assert.deepEqual(writes, ['edited', 'other edited']);
			assert.isFalse(editor_state.saving);
			assert.isFalse(other_state.saving);
			assert.isFalse(other_state.has_unsaved_edits);
		});
	});

	test('closing the last tab clears a failed save error', async () => {
		app.diskfiles.select(test_diskfile.id, true);
		editor_state.current_content = 'edited';
		app.diskfiles.update = () => Promise.resolve({ ok: false, error: ERROR });
		await editor_state.save_changes();
		assert.strictEqual(editor_state.save_error, 'disk full');

		const tab = app.diskfiles.editor.tabs.by_diskfile_id.get(test_diskfile.id);
		assert.ok(tab);
		app.diskfiles.editor.close_tab(tab.id);

		assert.isNull(editor_state.save_error);
		// the draft is kept for the next time it's opened
		assert.strictEqual(editor_state.current_content, 'edited');
	});

	test('a disk-change broadcast landing before the response is not duplicated', async () => {
		editor_state.current_content = 'saved';
		const { deferred } = defer_update();

		const saving = editor_state.save_changes();
		// the filer broadcast wins the race with the RPC response
		test_diskfile.content = 'saved';
		editor_state.check_disk_changes();
		deferred.resolve({ ok: true, value: null });
		assert.isTrue(await saving);

		const history = editor_state.history;
		assert.strictEqual(history.entries.filter((entry) => entry.content === 'saved').length, 1);
		assert.isFalse(editor_state.has_unsaved_edits);
		assert.strictEqual(editor_state.current_content, 'saved');
		assert.isFalse(editor_state.has_changes);
	});
});

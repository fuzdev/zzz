// @vitest-environment jsdom

import {test, beforeEach, describe, assert} from 'vitest';

import {DiskfileHistory} from '$lib/diskfile_history.svelte.js';
import {DiskfilePath} from '$lib/diskfile_types.js';
import {create_uuid} from '$lib/zod_helpers.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {monkeypatch_zzz_for_tests} from './test_helpers.ts';

// Test data
const TEST_PATH = DiskfilePath.parse('/path/to/file.txt');
const TEST_CONTENT = 'Test content';

describe('DiskfileHistory', () => {
	// Test suite
	let app: Frontend;
	let history: DiskfileHistory;

	beforeEach(() => {
		// Create a real Zzz instance for each test
		app = monkeypatch_zzz_for_tests(new Frontend());

		// Create a fresh history instance for each test with the real Zzz instance
		history = new DiskfileHistory({
			app,
			json: {
				path: TEST_PATH,
				entries: [],
			},
		});
	});

	describe('initialization', () => {
		test('creates empty history state', () => {
			assert.strictEqual(history.path, TEST_PATH);
			assert.deepEqual(history.entries, []);
			assert.strictEqual(history.max_entries, 100);
			assert.isNull(history.current_entry);
		});
	});

	describe('entry management', () => {
		test('add_entry creates new entry with default options', () => {
			const entry = history.add_entry(TEST_CONTENT);

			// Verify entry was created with proper structure
			assert.strictEqual(history.entries.length, 1);
			assert.strictEqual(entry.content, TEST_CONTENT);
			assert.isDefined(entry.id);
			assert.strictEqual(typeof entry.created, 'number');
			assert.ok(!entry.is_disk_change);
			assert.ok(!entry.is_unsaved_edit);
			assert.ok(!entry.is_original_state);
		});

		test('add_entry with custom options sets all properties', () => {
			const custom_timestamp = Date.now() - 1000;

			const entry = history.add_entry(TEST_CONTENT, {
				created: custom_timestamp,
				is_disk_change: true,
				is_unsaved_edit: true,
				is_original_state: true,
				label: 'Custom Label',
			});

			// Verify all options were applied
			assert.strictEqual(entry.created, custom_timestamp);
			assert.ok(entry.is_disk_change);
			assert.ok(entry.is_unsaved_edit);
			assert.ok(entry.is_original_state);
			assert.strictEqual(entry.label, 'Custom Label');
		});

		test('add_entry skips duplicate content back-to-back', () => {
			// Add initial entry
			const first = history.add_entry(TEST_CONTENT);

			// Add duplicate entry
			const duplicate = history.add_entry(TEST_CONTENT);

			// Verify no new entry was added and original was returned
			assert.strictEqual(history.entries.length, 1);
			assert.deepEqual(duplicate, first);
			assert.strictEqual(duplicate.id, first.id);
		});

		test('add_entry creates immutable entry array', () => {
			// Get initial entries array reference
			const initial_entries = history.entries;

			// Add an entry
			history.add_entry(TEST_CONTENT);

			// Verify entries array was replaced, not mutated in place
			assert.notStrictEqual(history.entries, initial_entries);
			assert.strictEqual(history.entries.length, 1);
		});
	});

	describe('sorting and ordering', () => {
		test('entries are sorted by creation time (newest first)', () => {
			// Add entries with timestamps in non-chronological order
			const time3 = Date.now();
			const time2 = time3 - 1000;
			const time1 = time2 - 1000;

			history.add_entry('content 2', {created: time2});
			history.add_entry('content 3', {created: time3});
			history.add_entry('content 1', {created: time1});

			// Verify entries are sorted newest first
			assert.strictEqual(history.entries.length, 3);
			assert.strictEqual(history.entries[0]!.content, 'content 3');
			assert.strictEqual(history.entries[1]!.content, 'content 2');
			assert.strictEqual(history.entries[2]!.content, 'content 1');
		});

		test('current_entry returns most recent entry', () => {
			// Add entries
			history.add_entry('first entry');
			const latest = history.add_entry('latest entry');

			// Verify current_entry points to most recent
			assert.strictEqual(history.current_entry, history.entries[0]);
			assert.deepEqual(history.current_entry, latest);
		});

		test('current_entry is null when history is empty', () => {
			assert.isNull(history.current_entry);
		});
	});

	describe('capacity management', () => {
		test('add_entry respects max_entries limit', () => {
			// Set a small limit
			history.max_entries = 3;

			// Add more entries than the maximum
			history.add_entry('content 1', {created: Date.now() - 3000});
			history.add_entry('content 2', {created: Date.now() - 2000});
			history.add_entry('content 3', {created: Date.now() - 1000});
			history.add_entry('content 4', {created: Date.now()});

			// Verify only the most recent entries were kept
			assert.strictEqual(history.entries.length, 3);
			assert.strictEqual(history.entries[0]!.content, 'content 4');
			assert.strictEqual(history.entries[1]!.content, 'content 3');
			assert.strictEqual(history.entries[2]!.content, 'content 2');
		});

		test('add_entry correctly handles insertion with capacity limit', () => {
			// Set a small limit
			history.max_entries = 2;

			// Add entry with middle timestamp
			const middle_time = Date.now() - 1000;
			history.add_entry('middle entry', {created: middle_time});

			// Add entry with newest timestamp
			const newest_time = Date.now();
			history.add_entry('newest entry', {created: newest_time});

			// Add entry with oldest timestamp (should be dropped due to capacity)
			const oldest_time = Date.now() - 2000;
			history.add_entry('oldest entry', {created: oldest_time});

			// Verify correct entries were kept (newest two)
			assert.strictEqual(history.entries.length, 2);
			assert.strictEqual(history.entries[0]!.content, 'newest entry');
			assert.strictEqual(history.entries[1]!.content, 'middle entry');
		});
	});

	describe('entry lookup', () => {
		test('find_entry_by_id finds correct entry', () => {
			// Add some entries
			history.add_entry('content 1');
			const entry2 = history.add_entry('content 2');
			history.add_entry('content 3');

			// Find an entry by id
			const found = history.find_entry_by_id(entry2.id);

			// Verify the right entry was found
			assert.isDefined(found);
			assert.strictEqual(found!.id, entry2.id);
			assert.strictEqual(found!.content, 'content 2');
		});

		test('find_entry_by_id returns undefined for non-existent id', () => {
			// Add some entries
			history.add_entry('content 1');
			history.add_entry('content 2');

			// Try to find entry with non-existent id
			const unknown_id = create_uuid();
			const result = history.find_entry_by_id(unknown_id);

			// Verify undefined is returned
			assert.ok(result === undefined);
		});

		test('get_content returns content from entry', () => {
			// Add an entry
			const entry = history.add_entry('specific content');

			// Get content by id
			const content = history.get_content(entry.id);

			// Verify content was retrieved
			assert.strictEqual(content, 'specific content');
		});

		test('get_content returns null for non-existent id', () => {
			// Add some entries
			history.add_entry('content 1');

			// Try to get content with non-existent id
			const unknown_id = create_uuid();
			const content = history.get_content(unknown_id);

			// Verify null is returned
			assert.isNull(content);
		});
	});

	describe('history clearing', () => {
		test('clear_except_current keeps only newest entry', () => {
			// Add multiple entries
			history.add_entry('old content 1');
			history.add_entry('old content 2');
			const newest = history.add_entry('newest content');

			// Verify we have multiple entries
			assert.strictEqual(history.entries.length, 3);

			// Clear all except current
			history.clear_except_current();

			// Verify only newest remains
			assert.strictEqual(history.entries.length, 1);
			assert.strictEqual(history.entries[0]!.id, newest.id);
			assert.strictEqual(history.entries[0]!.content, 'newest content');
		});

		test('clear_except_current handles empty history', () => {
			// Start with empty history
			assert.strictEqual(history.entries.length, 0);

			// Call clear - should not error
			history.clear_except_current();

			// Should still be empty
			assert.strictEqual(history.entries.length, 0);
		});

		test('clear_except_current with keep predicate preserves matching entries', () => {
			// Add entries with different flags
			const original = history.add_entry('original state', {is_original_state: true});
			history.add_entry('regular edit');
			const newest = history.add_entry('newest content');

			// Clear except current and original state entries
			history.clear_except_current((entry) => entry.is_original_state);

			// Verify newest and original entries were kept
			assert.strictEqual(history.entries.length, 2);
			assert.strictEqual(history.entries[0]!.id, newest.id);
			assert.strictEqual(history.entries[1]!.id, original.id);
		});

		test('clear_except_current with single entry does nothing', () => {
			// Add just one entry
			const entry = history.add_entry('single entry');

			// Clear except current
			history.clear_except_current();

			// Verify entry is still there
			assert.strictEqual(history.entries.length, 1);
			assert.strictEqual(history.entries[0]!.id, entry.id);
		});
	});

	describe('edge cases and integration', () => {
		test('add_entry with same content but different options creates new entry', () => {
			// Add first entry
			history.add_entry(TEST_CONTENT, {is_disk_change: true});

			// Add entry with same content but different options
			const second = history.add_entry(TEST_CONTENT, {is_unsaved_edit: true});

			// Both entries should be added since they represent different states
			assert.strictEqual(history.entries.length, 2);
			assert.ok(second.is_unsaved_edit);
		});

		test('complex editing workflow', () => {
			// Add original state
			const original = history.add_entry('original content', {
				is_original_state: true,
				is_disk_change: true,
			});

			// Add some edits
			history.add_entry('first edit', {is_unsaved_edit: true});
			history.add_entry('second edit', {is_unsaved_edit: true});

			// Add a save
			const saved = history.add_entry('saved content', {is_disk_change: true});

			// More edits
			const latest = history.add_entry('latest edit', {is_unsaved_edit: true});

			// Verify state
			assert.strictEqual(history.entries.length, 5);
			assert.deepEqual(history.current_entry, latest);

			// Clear except saved and current
			history.clear_except_current((entry) => entry.is_disk_change);

			// Should have original, saved, and latest
			assert.strictEqual(history.entries.length, 3);
			assert.strictEqual(history.entries[0]!.id, latest.id);
			assert.strictEqual(history.entries[1]!.id, saved.id);
			assert.strictEqual(history.entries[2]!.id, original.id);
		});
	});
});

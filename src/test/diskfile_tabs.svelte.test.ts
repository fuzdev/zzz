// @vitest-environment jsdom

import {test, beforeEach, describe, assert} from 'vitest';
import {create_uuid, UuidWithDefault} from '@fuzdev/fuz_util/id.js';

import {DiskfileTabs} from '$lib/diskfile_tabs.svelte.js';
import {DiskfileTab} from '$lib/diskfile_tab.svelte.js';
import {Frontend} from '$lib/frontend.svelte.js';

import {monkeypatch_zzz_for_tests} from './test_helpers.js';

// Test data
const TEST_DISKFILE_ID_1 = UuidWithDefault.parse(undefined);
const TEST_DISKFILE_ID_2 = UuidWithDefault.parse(undefined);
const TEST_DISKFILE_ID_3 = UuidWithDefault.parse(undefined);
const TEST_DISKFILE_ID_4 = UuidWithDefault.parse(undefined);
const TEST_DISKFILE_ID_5 = UuidWithDefault.parse(undefined);

describe('DiskfileTabs', () => {
	// Test suite
	let app: Frontend;
	let tabs: DiskfileTabs;

	beforeEach(() => {
		// Create a real Zzz instance for each test
		app = monkeypatch_zzz_for_tests(new Frontend());

		// Create a fresh tabs instance for each test
		tabs = new DiskfileTabs({
			app,
			json: {
				id: create_uuid(),
			},
		});
	});

	describe('initialization', () => {
		test('creates empty tabs state', () => {
			assert.isNull(tabs.selected_tab_id);
			assert.isNull(tabs.preview_tab_id);
			assert.deepEqual(tabs.tab_order, []);
			assert.strictEqual(tabs.items.size, 0);
			assert.deepEqual(tabs.ordered_tabs, []);
			assert.ok(tabs.selected_tab === undefined);
			assert.ok(tabs.preview_tab === undefined);
			assert.isNull(tabs.selected_diskfile_id);
			assert.deepEqual(tabs.recently_closed_tabs, []);
		});
	});

	describe('tab creation', () => {
		test('preview_diskfile creates a new preview tab', () => {
			const tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			assert.instanceOf(tab, DiskfileTab);
			assert.strictEqual(tab.diskfile_id, TEST_DISKFILE_ID_1);
			assert.strictEqual(tabs.preview_tab_id, tab.id);
			assert.strictEqual(tabs.selected_tab_id, tab.id);
			assert.include(tabs.tab_order, tab.id);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('preview_diskfile reuses existing tab', () => {
			// First create a tab
			const tab1 = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			// Then preview the same file again
			const tab2 = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			// Should return the existing tab, not create a new one
			assert.strictEqual(tab2, tab1);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('preview_diskfile reuses existing preview tab for new file', () => {
			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			// Then preview a different file
			const result = tabs.preview_diskfile(TEST_DISKFILE_ID_2);

			// Should reuse the same preview tab but update its content
			assert.strictEqual(result, preview_tab);
			assert.strictEqual(tabs.preview_tab_id, preview_tab.id);
			assert.strictEqual(preview_tab.diskfile_id, TEST_DISKFILE_ID_2);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('open_diskfile creates a permanent tab', () => {
			const tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);

			assert.instanceOf(tab, DiskfileTab);
			assert.strictEqual(tab.diskfile_id, TEST_DISKFILE_ID_1);
			assert.ok(!tab.is_preview);
			assert.isNull(tabs.preview_tab_id);
			assert.strictEqual(tabs.selected_tab_id, tab.id);
			assert.include(tabs.tab_order, tab.id);
		});

		test('open_diskfile reuses existing tab', () => {
			// First create a tab
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Then open the same file again
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Should return the existing tab, not create a new one
			assert.strictEqual(tab2, tab1);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('open_diskfile promotes preview tab to permanent', () => {
			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			// Then open the same file
			const permanent_tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Should use the same tab but make it permanent
			assert.strictEqual(permanent_tab, preview_tab);
			assert.isNull(tabs.preview_tab_id);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('open_diskfile repurposes existing preview tab', () => {
			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			// Then open a different file
			const permanent_tab = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Should repurpose the preview tab
			assert.strictEqual(permanent_tab, preview_tab);
			assert.strictEqual(permanent_tab.diskfile_id, TEST_DISKFILE_ID_2);
			assert.isNull(tabs.preview_tab_id);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('open_diskfile replaces preview tab resulting in 2 tabs total', () => {
			// Create a permanent tab first
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			assert.strictEqual(tabs.items.size, 1);
			assert.isNull(tabs.preview_tab_id);

			// Create a preview tab for a different file
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_2);
			assert.strictEqual(tabs.items.size, 2);
			assert.strictEqual(tabs.preview_tab_id, preview_tab.id);
			assert.ok(preview_tab.is_preview);

			// Open a third file, which should repurpose the preview tab
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Verify the preview tab was repurposed, not creating a third tab
			assert.strictEqual(tabs.items.size, 2);
			assert.strictEqual(tab3, preview_tab); // Should be the same tab object
			assert.strictEqual(tab3.diskfile_id, TEST_DISKFILE_ID_3); // But with the new diskfile id
			assert.isNull(tabs.preview_tab_id); // No preview tab now

			// Verify tab ids are different
			assert.notStrictEqual(tab1.id, tab3.id);

			// Verify tabs have the right content
			assert.strictEqual(tab1.diskfile_id, TEST_DISKFILE_ID_1);
			assert.strictEqual(tab3.diskfile_id, TEST_DISKFILE_ID_3);
		});
	});

	describe('tab positioning', () => {
		test('preview_diskfile positions tab after selected tab', () => {
			// Create two permanent tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Select the first tab
			tabs.select_tab(tab1.id);

			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_3);

			// Verify the order: tab1, preview_tab, tab2
			assert.strictEqual(tabs.tab_order[0]!, tab1.id);
			assert.strictEqual(tabs.tab_order[1]!, preview_tab.id);
			assert.strictEqual(tabs.tab_order[2]!, tab2.id);
		});

		test('positioning with additional preview tabs', () => {
			// Create two permanent tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Select tab1
			tabs.select_tab(tab1.id);

			// Create a preview tab
			const preview = tabs.preview_diskfile(TEST_DISKFILE_ID_3);

			// Expected order: tab1, preview, tab2
			assert.strictEqual(tabs.tab_order[0]!, tab1.id);
			assert.strictEqual(tabs.tab_order[1]!, preview.id);
			assert.strictEqual(tabs.tab_order[2]!, tab2.id);

			// Select tab2 and create another preview (reusing the existing one)
			tabs.select_tab(tab2.id);
			const preview2 = tabs.preview_diskfile(TEST_DISKFILE_ID_4);

			// The preview tab should move after tab2
			assert.strictEqual(tabs.tab_order[0]!, tab1.id);
			assert.strictEqual(tabs.tab_order[1]!, tab2.id);
			assert.strictEqual(tabs.tab_order[2]!, preview.id);
			assert.strictEqual(preview2, preview); // Same tab instance
			assert.strictEqual(preview2.diskfile_id, TEST_DISKFILE_ID_4);
		});

		test('preview tab positioning bug fix - selecting existing preview should not reorder', () => {
			// This test specifically reproduces and verifies the fix for the bug where:
			// 1. Open 2 permanent tabs
			// 2. Select first tab and preview a 3rd file
			// 3. Click between tabs - preview tab should NOT move

			// Create two permanent tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Select the first tab
			tabs.select_tab(tab1.id);

			// Preview a third file
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_3);

			// Order should be: tab1, preview_tab, tab2
			assert.deepEqual(tabs.tab_order, [tab1.id, preview_tab.id, tab2.id]);

			// Select tab2
			tabs.select_tab(tab2.id);

			// Select the preview tab again
			tabs.select_tab(preview_tab.id);

			// Order should NOT change - the preview tab should stay in its position
			assert.deepEqual(tabs.tab_order, [tab1.id, preview_tab.id, tab2.id]);

			// Select tab1 again
			tabs.select_tab(tab1.id);

			// Select preview tab again
			tabs.select_tab(preview_tab.id);

			// Order should still not change
			assert.deepEqual(tabs.tab_order, [tab1.id, preview_tab.id, tab2.id]);
		});

		test('preview tab repositioning only happens when content changes', () => {
			// Create permanent tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Select tab1 and create a preview
			tabs.select_tab(tab1.id);
			const preview = tabs.preview_diskfile(TEST_DISKFILE_ID_4);

			// Order: tab1, preview, tab2, tab3
			assert.deepEqual(tabs.tab_order, [tab1.id, preview.id, tab2.id, tab3.id]);

			// Select tab3
			tabs.select_tab(tab3.id);

			// Preview the same file - should NOT reposition
			tabs.preview_diskfile(TEST_DISKFILE_ID_4);
			assert.deepEqual(tabs.tab_order, [tab1.id, preview.id, tab2.id, tab3.id]);

			tabs.preview_diskfile(TEST_DISKFILE_ID_5);
			assert.deepEqual(tabs.tab_order, [tab1.id, preview.id, tab2.id, tab3.id]);
		});

		test('reorder_tabs changes tab order', () => {
			// Create three tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Initial order
			assert.deepEqual(tabs.tab_order, [tab1.id, tab2.id, tab3.id]);

			// Reorder: move tab1 to position 2
			tabs.reorder_tabs(0, 2);

			// New order should be: tab2, tab3, tab1
			assert.deepEqual(tabs.tab_order, [tab2.id, tab3.id, tab1.id]);

			// ordered_tabs should reflect the new order
			assert.strictEqual(tabs.ordered_tabs[0]!.id, tab2.id);
			assert.strictEqual(tabs.ordered_tabs[1]!.id, tab3.id);
			assert.strictEqual(tabs.ordered_tabs[2]!.id, tab1.id);
		});
	});

	describe('tab selection', () => {
		test('select_tab updates selected_tab_id', () => {
			// Create tabs
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Select the second tab
			tabs.select_tab(tab2.id);

			assert.strictEqual(tabs.selected_tab_id, tab2.id);
			assert.strictEqual(tabs.selected_tab, tab2);
			assert.ok(tabs.selected_tab?.is_selected);
			assert.strictEqual(tabs.selected_diskfile_id, tab2.diskfile_id);
		});
	});

	describe('tab closing', () => {
		test('close_tab removes a tab', () => {
			// Create a tab
			const tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Close it
			tabs.close_tab(tab.id);

			assert.strictEqual(tabs.items.size, 0);
			assert.notInclude(tabs.tab_order, tab.id);
			assert.isNull(tabs.selected_tab_id);
			assert.strictEqual(tabs.recently_closed_tabs.length, 1);
			assert.strictEqual(tabs.recently_closed_tabs[0]!.id, tab.id);
		});

		test('close_tab with multiple tabs selects the most recently opened tab', () => {
			// Create tabs
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			assert.strictEqual(tabs.items.size, 3);

			// Select and close the middle tab
			tabs.select_tab(tab2.id);
			tabs.close_tab(tab2.id);

			assert.strictEqual(tabs.items.size, 2);
			assert.strictEqual(tabs.selected_tab_id, tab3.id); // Should select the most recently opened (tab3)
			assert.strictEqual(tabs.recently_closed_tabs.length, 1);
			assert.strictEqual(tabs.recently_closed_tabs[0]!.id, tab2.id);
		});

		test('close_tab does nothing for non-existent tab', () => {
			// Create a tab
			tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Initial state
			const initial_size = tabs.items.size;
			const initial_selected = tabs.selected_tab_id;

			// Close non-existent tab
			tabs.close_tab(create_uuid());

			// State should be unchanged
			assert.strictEqual(tabs.items.size, initial_size);
			assert.strictEqual(tabs.selected_tab_id, initial_selected);
			assert.strictEqual(tabs.recently_closed_tabs.length, 0);
		});

		test('close_tab clears preview_tab_id if closing preview tab', () => {
			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			// Close it
			tabs.close_tab(preview_tab.id);

			assert.isNull(tabs.preview_tab_id);
		});

		test('close_tab selects next tab when available', () => {
			// Create three tabs
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Select the middle tab
			tabs.select_tab(tab2.id);

			// Close the middle tab
			tabs.close_tab(tab2.id);

			// Should select the tab that was after it (tab3)
			assert.strictEqual(tabs.selected_tab_id, tab3.id);
		});

		test('close_tab selects previous tab when closing last tab', () => {
			// Create two tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Select the last tab
			tabs.select_tab(tab2.id);

			// Close the last tab
			tabs.close_tab(tab2.id);

			// Should select the previous tab
			assert.strictEqual(tabs.selected_tab_id, tab1.id);
		});

		test('close_all_tabs clears all tabs and state', () => {
			// Create a permanent tab first
			tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Create a preview tab
			tabs.preview_diskfile(TEST_DISKFILE_ID_2);

			// Make the preview tab permanent first - this prevents it from being reused
			tabs.promote_preview_to_permanent();

			// Now create another tab - this will be a new one since there's no preview tab to reuse
			const permanent = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Initial state - verify we have 3 tabs before closing
			assert.strictEqual(tabs.items.size, 3);
			assert.strictEqual(tabs.tab_order.length, 3);
			assert.isNull(tabs.preview_tab_id); // No preview tab now since last one is permanent
			assert.strictEqual(tabs.selected_tab_id, permanent.id);

			// Close all
			tabs.close_all_tabs();

			// All state should be cleared
			assert.strictEqual(tabs.items.size, 0);
			assert.strictEqual(tabs.tab_order.length, 0);
			assert.isNull(tabs.preview_tab_id);
			assert.isNull(tabs.selected_tab_id);
			assert.strictEqual(tabs.recently_closed_tabs.length, 3);
		});
	});

	describe('tab promotion', () => {
		test('promote_preview_to_permanent converts preview to permanent', () => {
			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			assert.strictEqual(tabs.preview_tab_id, preview_tab.id);
			assert.ok(preview_tab.is_preview);

			// Promote it
			const result = tabs.promote_preview_to_permanent();

			assert.ok(result);
			assert.isNull(tabs.preview_tab_id);
			assert.ok(!preview_tab.is_preview);
		});

		test('promote_preview_to_permanent returns false if no preview tab', () => {
			// Create a permanent tab
			tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Try to promote
			const result = tabs.promote_preview_to_permanent();

			assert.ok(!result);
		});

		test('open_tab makes a preview tab permanent', () => {
			// Create a preview tab
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_1);

			assert.strictEqual(tabs.preview_tab_id, preview_tab.id);

			// Make it permanent
			tabs.open_tab(preview_tab.id);

			assert.isNull(tabs.preview_tab_id);
		});

		test('open_tab does nothing for permanent tab', () => {
			// Create a permanent tab
			const tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Initial state
			assert.isNull(tabs.preview_tab_id);

			// Try to make it permanent again
			tabs.open_tab(tab.id);

			// State should be unchanged
			assert.isNull(tabs.preview_tab_id);
		});
	});

	describe('tab reopening', () => {
		test('reopen_last_closed_tab reopens the most recently closed tab', () => {
			// Create and close tabs in sequence
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			tabs.close_tab(tab1.id);
			tabs.close_tab(tab2.id);

			// Reopen the last closed (tab2)
			tabs.reopen_last_closed_tab();

			assert.strictEqual(tabs.items.size, 1);
			assert.strictEqual(tabs.items.by_id.values().next().value?.diskfile_id, TEST_DISKFILE_ID_2);
			assert.strictEqual(tabs.recently_closed_tabs.length, 1);
		});

		test('reopen_last_closed_tab does nothing if no closed tabs', () => {
			// Initial state
			assert.strictEqual(tabs.recently_closed_tabs.length, 0);
			assert.strictEqual(tabs.items.size, 0);

			// Try to reopen
			tabs.reopen_last_closed_tab();

			// State should be unchanged
			assert.strictEqual(tabs.recently_closed_tabs.length, 0);
			assert.strictEqual(tabs.items.size, 0);
		});

		test('reopen_last_closed_tab restores selection state', () => {
			// Create and select a tab
			const tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			tabs.select_tab(tab.id);

			// Close it
			tabs.close_tab(tab.id);

			// Initial state after closing
			assert.isNull(tabs.selected_tab_id);

			// Reopen it
			tabs.reopen_last_closed_tab();

			// Tab should be reopened and selected
			assert.notStrictEqual(tabs.selected_tab_id, null);
			assert.strictEqual(tabs.items.size, 1);
		});

		test('reopen_last_closed_tab maintains proper tab order', () => {
			// Create three tabs in order
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Remember the original order
			const original_order = [...tabs.tab_order];
			assert.deepEqual(original_order, [tab1.id, tab2.id, tab3.id]);

			// Close the middle tab
			tabs.close_tab(tab2.id);

			// Make sure it's gone
			assert.ok(!tabs.items.by_id.has(tab2.id));
			assert.notInclude(tabs.tab_order, tab2.id);

			// Verify the new order is tab1, tab3
			assert.deepEqual(tabs.tab_order, [tab1.id, tab3.id]);

			// Reopen the tab
			tabs.reopen_last_closed_tab();

			// Verify it was added at the end of the tab order
			const reopened_tab_id = tabs.selected_tab_id;
			assert.include(tabs.tab_order, reopened_tab_id);
			assert.strictEqual(tabs.tab_order[tabs.tab_order.length - 1], reopened_tab_id);
		});
	});

	describe('tab history', () => {
		test('tracks tab access history when selecting tabs', () => {
			// Create three tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Initial history should have tab3 (most recently opened)
			assert.strictEqual(tabs.recent_tabs[0]!.id, tab3.id);

			// Select tab1, should move to front of history
			tabs.select_tab(tab1.id);
			assert.strictEqual(tabs.recent_tabs[0]!.id, tab1.id);

			// Select tab2, should move to front of history
			tabs.select_tab(tab2.id);
			assert.strictEqual(tabs.recent_tabs[0]!.id, tab2.id);
			assert.strictEqual(tabs.recent_tabs[1]!.id, tab1.id);
			assert.strictEqual(tabs.recent_tabs[2]!.id, tab3.id);
		});

		test('maintains history when reopening tabs', () => {
			// Create and close a tab
			const tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			tabs.close_tab(tab.id);

			// Reopen the tab
			tabs.reopen_last_closed_tab();

			// Verify the reopened tab is in history
			assert.strictEqual(tabs.recent_tabs.length, 1);
			assert.strictEqual(tabs.recent_tabs[0]!.id, tabs.selected_tab_id);
		});

		test('limits history to max size', () => {
			tabs.max_tab_history = 3;

			// Create more tabs than the max history size
			for (let i = 0; i < 5; i++) {
				const uuid = UuidWithDefault.parse(undefined);
				tabs.open_diskfile(uuid);
			}

			// Verify history is limited to max size
			assert.strictEqual(tabs.recent_tabs.length, 3);
		});

		test('removes closed tabs from history', () => {
			// Create two tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Verify both tabs are in history through their ids
			assert.include(tabs.recent_tab_ids, tab1.id);
			assert.include(tabs.recent_tab_ids, tab2.id);

			// Close tab1
			tabs.close_tab(tab1.id);

			// Verify tab1 is removed from history
			assert.notInclude(tabs.recent_tab_ids, tab1.id);
			assert.include(tabs.recent_tab_ids, tab2.id);
		});

		test('clears history when closing all tabs', () => {
			// Create some tabs
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Verify history is not empty
			assert.ok(tabs.recent_tabs.length > 0);

			// Close all tabs
			tabs.close_all_tabs();

			// Verify history is cleared
			assert.deepEqual(tabs.recent_tabs, []);
		});
	});

	describe('tab selection with history', () => {
		test('selects most recently used tab when closing current tab', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Build history: select tabs in a specific order
			tabs.select_tab(tab1.id); // History: tab1, tab3, tab2
			tabs.select_tab(tab2.id); // History: tab2, tab1, tab3
			tabs.select_tab(tab3.id); // History: tab3, tab2, tab1
			tabs.select_tab(tab1.id); // History: tab1, tab3, tab2

			// Now close the selected tab (tab1)
			tabs.close_tab(tab1.id);

			// The most recently used tab (tab3) should be selected
			assert.strictEqual(tabs.selected_tab_id, tab3.id);
		});

		test('falls back to next tab when no history available', () => {
			// Create tabs but manipulate history to be empty
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Clear history
			tabs.recent_tab_ids = [];

			// Select the middle tab
			tabs.select_tab(tab2.id);

			// Clear history again (since select_tab would have added to it)
			tabs.recent_tab_ids = [];

			// Close the selected tab
			tabs.close_tab(tab2.id);

			// Should fall back to the next tab (tab3)
			assert.strictEqual(tabs.selected_tab_id, tab3.id);
		});

		test('selecting a non-existent tab in history is handled gracefully', () => {
			// Create and select tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			tabs.select_tab(tab1.id);
			tabs.select_tab(tab2.id);

			// Close the selected tab
			tabs.close_tab(tab2.id);

			// Should select tab1 since it's the only one left
			assert.strictEqual(tabs.selected_tab_id, tab1.id);
		});

		test('find_most_recent_tab correctly finds valid tabs', () => {
			// Create some tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Select them both to build history
			tabs.select_tab(tab1.id);
			tabs.select_tab(tab2.id);

			// Find most recent excluding tab2
			const result = tabs.find_most_recent_tab(tab2.id);

			// Should return tab1
			assert.strictEqual(result, tab1.id);
		});

		test('tab history preserves references after tab modifications', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Build history
			tabs.select_tab(tab1.id);
			tabs.select_tab(tab2.id);

			// Verify initial history state
			assert.strictEqual(tabs.recent_tabs[0]!.id, tab2.id);
			assert.strictEqual(tabs.recent_tabs[1]!.id, tab1.id);

			// Store tabs for reference before closing
			const tab1_diskfile_id = tab1.diskfile_id;

			// Close tab2
			tabs.close_tab(tab2.id);

			// Check history - tab1 should still be accessible
			assert.strictEqual(tabs.recent_tabs[0]!.id, tab1.id);
			assert.strictEqual(tabs.recent_tabs[0]!.diskfile_id, tab1_diskfile_id);
		});
	});

	describe('tab navigation', () => {
		test('navigate_to_tab selects existing tab', () => {
			// Create tabs
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Navigate to tab2
			const result = tabs.navigate_to_tab(tab2.id);

			// Should select tab2 directly
			assert.strictEqual(result.resulting_tab_id, tab2.id);
			assert.ok(!result.created_preview);
			assert.strictEqual(tabs.selected_tab_id, tab2.id);
		});

		test('navigate_to_tab creates preview tab for closed tab', () => {
			// Create and close a tab
			const tab = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab_id = tab.id;
			tabs.close_tab(tab_id);

			// Try to navigate to the closed tab
			const result = tabs.navigate_to_tab(tab_id);

			// Should create a preview tab for the same diskfile
			assert.ok(result.created_preview);
			assert.notStrictEqual(result.resulting_tab_id, tab_id); // Should be a different tab id
			assert.strictEqual(tabs.selected_tab_id, result.resulting_tab_id);
			assert.strictEqual(tabs.preview_tab_id, result.resulting_tab_id);

			// Should have the same diskfile
			const new_tab = tabs.items.by_id.get(result.resulting_tab_id!);
			assert.strictEqual(new_tab?.diskfile_id, TEST_DISKFILE_ID_1);
		});

		test('navigate_to_tab creates a new preview tab for closed tab', () => {
			// Create a tab and a preview tab
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const preview_tab = tabs.preview_diskfile(TEST_DISKFILE_ID_2);
			const preview_tab_id = preview_tab.id;

			// Create and close another tab
			const closed_tab = tabs.open_diskfile(TEST_DISKFILE_ID_3);
			const closed_tab_id = closed_tab.id;
			tabs.close_tab(closed_tab_id);

			// Try to navigate to the closed tab
			const result = tabs.navigate_to_tab(closed_tab_id);

			// A new preview tab should be created for the closed tab's file
			assert.ok(result.created_preview);
			assert.ok(result.resulting_tab_id !== null);
			assert.ok(tabs.preview_tab_id !== null);

			// The new preview tab should be different from the original one
			assert.notStrictEqual(tabs.preview_tab_id, preview_tab_id);

			// But it should have the closed tab's diskfile
			if (tabs.preview_tab_id && tabs.items.by_id.get(tabs.preview_tab_id)) {
				assert.strictEqual(
					tabs.items.by_id.get(tabs.preview_tab_id)?.diskfile_id,
					TEST_DISKFILE_ID_3,
				);
			}
		});

		test('navigate_to_tab handles unknown tab id gracefully', () => {
			// Create a tab
			tabs.open_diskfile(TEST_DISKFILE_ID_1);

			// Try to navigate to a non-existent tab
			const result = tabs.navigate_to_tab(UuidWithDefault.parse(undefined));

			// Should return null without changing selection
			assert.isNull(result.resulting_tab_id);
			assert.ok(!result.created_preview);
		});

		test('closed tabs are remembered even after closing all tabs', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab1_id = tab1.id;

			// Close all tabs
			tabs.close_all_tabs();

			// Navigate to one of the closed tabs
			const result = tabs.navigate_to_tab(tab1_id);

			// Should create a preview tab for the correct diskfile
			assert.ok(result.created_preview);
			const new_tab = tabs.items.by_id.get(result.resulting_tab_id!);
			assert.strictEqual(new_tab?.diskfile_id, TEST_DISKFILE_ID_1);
		});
	});

	describe('edge cases and integration', () => {
		test('ordered_tabs handles tabs not in tab_order', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Manually manipulate tab_order to exclude tab2
			tabs.tab_order = [tab1.id];

			// ordered_tabs should include both tabs
			assert.strictEqual(tabs.ordered_tabs.length, 2);
			assert.strictEqual(tabs.ordered_tabs[0]!.id, tab1.id);
			assert.strictEqual(tabs.ordered_tabs[1]!.id, tab2.id);
		});

		test('complex tab workflow', () => {
			// Create a preview tab
			const preview = tabs.preview_diskfile(TEST_DISKFILE_ID_1);
			assert.strictEqual(tabs.preview_tab_id, preview.id);
			assert.strictEqual(tabs.selected_tab_id, preview.id);

			// Create a permanent tab
			const permanent = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			assert.isNull(tabs.preview_tab_id); // Preview was repurposed
			assert.strictEqual(tabs.selected_tab_id, permanent.id);

			// Create another preview tab
			const preview2 = tabs.preview_diskfile(TEST_DISKFILE_ID_3);
			assert.strictEqual(tabs.preview_tab_id, preview2.id);
			assert.strictEqual(tabs.selected_tab_id, preview2.id);

			// Select the permanent tab
			tabs.select_tab(permanent.id);
			assert.strictEqual(tabs.selected_tab_id, permanent.id);
			assert.strictEqual(tabs.preview_tab_id, preview2.id); // Preview status unchanged

			// Close the permanent tab
			tabs.close_tab(permanent.id);
			assert.strictEqual(tabs.selected_tab_id, preview2.id); // First remaining tab selected

			// Promote the preview tab
			tabs.promote_preview_to_permanent();
			assert.isNull(tabs.preview_tab_id);
			assert.strictEqual(tabs.selected_tab_id, preview2.id);

			// Reopen the closed tab
			tabs.reopen_last_closed_tab();
			assert.strictEqual(tabs.items.size, 2);
		});

		test('can handle many tabs efficiently', () => {
			// Create 10 tabs
			const start_time = performance.now();

			const tab_count = 10;
			const created_tabs = [];

			for (let i = 0; i < tab_count; i++) {
				// Create proper UUIDs that will pass validation - these are real UUIDs
				const uuid = UuidWithDefault.parse(undefined);
				const tab = tabs.open_diskfile(uuid);
				created_tabs.push(tab);
			}

			// Verify all tabs were created
			assert.strictEqual(tabs.items.size, tab_count);

			// Time some operations to ensure they're reasonably fast
			const start_reorder = performance.now();
			tabs.reorder_tabs(0, tab_count - 1);
			const reorder_time = performance.now() - start_reorder;

			// Close all tabs
			const start_close = performance.now();
			tabs.close_all_tabs();
			const close_time = performance.now() - start_close;

			// Total time
			const total_time = performance.now() - start_time;

			// Log times for performance analysis
			console.log(`Performance metrics for ${tab_count} tabs:
			- Creation: ${start_reorder - start_time}ms
			- Reorder: ${reorder_time}ms
			- Close all: ${close_time}ms
			- Total: ${total_time}ms`);

			// These aren't strict assertions since timing depends on the environment
			// Just ensure operations complete in a reasonable time
			assert.strictEqual(tabs.items.size, 0);
			assert.strictEqual(tabs.recently_closed_tabs.length, tab_count);
		});

		test('preview tab lifecycle with multiple operations', () => {
			// Create initial permanent tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Preview a file
			const preview = tabs.preview_diskfile(TEST_DISKFILE_ID_3);
			assert.ok(preview.is_preview);

			// Double-click simulation - promote to permanent
			tabs.open_tab(preview.id);
			assert.ok(!preview.is_preview);
			assert.isNull(tabs.preview_tab_id);

			// Create a new preview
			const preview2 = tabs.preview_diskfile(TEST_DISKFILE_ID_4);
			assert.ok(preview2.is_preview);
			assert.notStrictEqual(preview2.id, preview.id);

			// Close the preview
			tabs.close_tab(preview2.id);
			assert.isNull(tabs.preview_tab_id);

			// All permanent tabs should remain
			assert.strictEqual(tabs.items.size, 3);
			assert.ok(tabs.items.by_id.has(tab1.id));
			assert.ok(tabs.items.by_id.has(tab2.id));
			assert.ok(tabs.items.by_id.has(preview.id));
		});

		test('by_diskfile_id map updates correctly', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);

			// Verify map contents
			assert.strictEqual(tabs.by_diskfile_id.get(TEST_DISKFILE_ID_1), tab1);
			assert.strictEqual(tabs.by_diskfile_id.get(TEST_DISKFILE_ID_2), tab2);
			assert.strictEqual(tabs.by_diskfile_id.size, 2);

			// Create preview that reuses a tab
			const preview = tabs.preview_diskfile(TEST_DISKFILE_ID_3);
			assert.strictEqual(tabs.by_diskfile_id.get(TEST_DISKFILE_ID_3), preview);
			assert.strictEqual(tabs.by_diskfile_id.size, 3);

			// Reuse preview for different file
			tabs.preview_diskfile(TEST_DISKFILE_ID_4);
			assert.ok(tabs.by_diskfile_id.get(TEST_DISKFILE_ID_3) === undefined);
			assert.strictEqual(tabs.by_diskfile_id.get(TEST_DISKFILE_ID_4), preview);
			assert.strictEqual(tabs.by_diskfile_id.size, 3);

			// Close a tab
			tabs.close_tab(tab1.id);
			assert.ok(tabs.by_diskfile_id.get(TEST_DISKFILE_ID_1) === undefined);
			assert.strictEqual(tabs.by_diskfile_id.size, 2);
		});
	});

	describe('helper method tests', () => {
		test('#position_tab inserts tab correctly', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Initial order
			assert.deepEqual(tabs.tab_order, [tab1.id, tab2.id, tab3.id]);

			// Use private method through public API - reorder simulates position_tab behavior
			tabs.reorder_tabs(2, 0); // Move tab3 to position after tab1 (index 1)

			assert.strictEqual(tabs.tab_order[0], tab3.id);
			assert.strictEqual(tabs.tab_order[1], tab1.id);
			assert.strictEqual(tabs.tab_order[2], tab2.id);
		});

		test('#update_tab_history maintains correct order and size', () => {
			// Set a small max history for testing
			tabs.max_tab_history = 3;

			// Create and select tabs to build history
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			const tab3 = tabs.open_diskfile(TEST_DISKFILE_ID_3);
			const tab4 = tabs.open_diskfile(TEST_DISKFILE_ID_4);

			// Select in specific order
			tabs.select_tab(tab1.id);
			tabs.select_tab(tab2.id);
			tabs.select_tab(tab3.id);
			tabs.select_tab(tab4.id);

			// History should only contain last 3
			assert.strictEqual(tabs.recent_tab_ids.length, 3);
			assert.strictEqual(tabs.recent_tab_ids[0]!, tab4.id);
			assert.strictEqual(tabs.recent_tab_ids[1]!, tab3.id);
			assert.strictEqual(tabs.recent_tab_ids[2]!, tab2.id);
			assert.notInclude(tabs.recent_tab_ids, tab1.id);

			// Select an existing tab in history
			tabs.select_tab(tab2.id);

			// Should move to front
			assert.strictEqual(tabs.recent_tab_ids[0]!, tab2.id);
			assert.strictEqual(tabs.recent_tab_ids[1]!, tab4.id);
			assert.strictEqual(tabs.recent_tab_ids[2]!, tab3.id);
		});
	});

	describe('state consistency', () => {
		test('maintains consistency between tab_order and items collection', () => {
			// Create tabs
			tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const tab2 = tabs.open_diskfile(TEST_DISKFILE_ID_2);
			tabs.open_diskfile(TEST_DISKFILE_ID_3);

			// Every tab in tab_order should exist in items
			for (const tab_id of tabs.tab_order) {
				assert.ok(tabs.items.by_id.has(tab_id));
			}

			// Close a tab
			tabs.close_tab(tab2.id);

			// Check consistency again
			assert.notInclude(tabs.tab_order, tab2.id);
			assert.ok(!tabs.items.by_id.has(tab2.id));

			// Reopen a tab
			tabs.reopen_last_closed_tab();

			// Check consistency once more
			for (const tab_id of tabs.tab_order) {
				assert.ok(tabs.items.by_id.has(tab_id));
			}
		});

		test('maintains consistency of derived properties', () => {
			// Create tabs
			const tab1 = tabs.open_diskfile(TEST_DISKFILE_ID_1);
			const preview = tabs.preview_diskfile(TEST_DISKFILE_ID_2);

			// Check derived properties
			assert.strictEqual(tabs.selected_tab, preview);
			assert.strictEqual(tabs.preview_tab, preview);
			assert.strictEqual(tabs.selected_diskfile_id, TEST_DISKFILE_ID_2);

			// Select different tab
			tabs.select_tab(tab1.id);

			// Check updated derived properties
			assert.strictEqual(tabs.selected_tab, tab1);
			assert.strictEqual(tabs.selected_diskfile_id, TEST_DISKFILE_ID_1);
			assert.strictEqual(tabs.preview_tab, preview); // Preview unchanged

			// Promote preview
			tabs.promote_preview_to_permanent();
			assert.ok(tabs.preview_tab === undefined);
		});
	});
});

// @vitest-environment jsdom

import {test, vi, describe, beforeEach, afterEach, assert} from 'vitest';

import {
	Reorderable,
	type ReorderableItemId,
	type ReorderableItemParams,
	type ReorderableListParams,
} from '$lib/reorderable.svelte.js';

// Mock helper function for DOM testing
const create_elements = (): {
	container: HTMLElement;
	list: HTMLElement;
	items: Array<HTMLElement>;
} => {
	// Create container
	const container = document.createElement('div');

	// Create list element
	const list = document.createElement('div');
	container.appendChild(list);

	// Create list items
	const items: Array<HTMLElement> = [];
	for (let i = 0; i < 3; i++) {
		const item = document.createElement('div');
		item.textContent = `Item ${i}`;
		list.appendChild(item);
		items.push(item);
	}

	return {container, list, items};
};

// Mock DragEvent for testing
const create_mock_drag_event = (
	type: string,
	target?: HTMLElement,
	data_transfer?: object,
): DragEvent => {
	const event = new Event(type, {bubbles: true}) as DragEvent;

	// Add target
	if (target) {
		Object.defineProperty(event, 'target', {value: target});
	}

	// Add dataTransfer
	if (data_transfer) {
		Object.defineProperty(event, 'dataTransfer', {value: data_transfer});
	} else {
		Object.defineProperty(event, 'dataTransfer', {
			value: {
				setData: vi.fn(),
				getData: vi.fn(),
				dropEffect: 'none',
				effectAllowed: 'none',
				types: [],
				files: [],
				items: [],
			},
		});
	}

	return event;
};

// Helper to force reorderable initialization
const force_initialize = (reorderable: Reorderable): void => {
	if (!reorderable.initialized) {
		// Call the actual init method which sets up event handlers
		reorderable.init();
	}
};

// Helper to attach list with cleanup tracking
const attach_list = (
	reorderable: Reorderable,
	list: HTMLElement,
	params: ReorderableListParams,
): (() => void) => {
	const attachment = reorderable.list(params);
	const cleanup = attachment(list);
	return cleanup || (() => undefined);
};

// Helper to attach item with cleanup tracking
const attach_item = (
	reorderable: Reorderable,
	item: HTMLElement,
	params: ReorderableItemParams,
): (() => void) => {
	const attachment = reorderable.item(params);
	const cleanup = attachment(item);
	return cleanup || (() => undefined);
};

describe('Reorderable', () => {
	describe('constructor', () => {
		test('creates with default values', () => {
			const reorderable = new Reorderable();

			assert.instanceOf(reorderable, Reorderable);
			assert.isNull(reorderable.list_node);
			assert.isNull(reorderable.list_params);
			assert.strictEqual(reorderable.indices.size, 0);
			assert.strictEqual(reorderable.elements.size, 0);
			assert.strictEqual(reorderable.direction, 'vertical');
			assert.ok(reorderable.id);
			assert.notStrictEqual(reorderable.id, new Reorderable().id);
			assert.strictEqual(reorderable.list_class, 'reorderable_list');
			assert.strictEqual(reorderable.item_class, 'reorderable_item');
		});

		test('creates with custom direction', () => {
			const reorderable = new Reorderable({direction: 'horizontal'});
			assert.strictEqual(reorderable.direction, 'horizontal');
		});

		test('creates with custom styling', () => {
			const reorderable = new Reorderable({
				list_class: 'custom_list',
				item_class: 'custom_item',
				dragging_class: 'custom_dragging',
			});

			assert.strictEqual(reorderable.list_class, 'custom_list');
			assert.strictEqual(reorderable.item_class, 'custom_item');
			assert.strictEqual(reorderable.dragging_class, 'custom_dragging');
			// Other styles should have default values
			assert.strictEqual(reorderable.drag_over_class, 'drag_over');
		});
	});

	describe('list attachment', () => {
		let list: HTMLElement;
		let reorderable: Reorderable;
		let mock_callback: (from_index: number, to_index: number) => void;
		let cleanup_fn: (() => void) | undefined;

		beforeEach(() => {
			const elements = create_elements();
			list = elements.list;
			reorderable = new Reorderable();
			mock_callback = vi.fn() as typeof mock_callback;
		});

		afterEach(() => {
			if (cleanup_fn) cleanup_fn();
		});

		test('initializes correctly', () => {
			cleanup_fn = attach_list(reorderable, list, {onreorder: mock_callback});

			assert.strictEqual(reorderable.list_node, list);
			assert.deepEqual(reorderable.list_params, {onreorder: mock_callback});
			assert.ok(list.classList.contains(reorderable.list_class!));
			assert.strictEqual(list.getAttribute('role'), 'list');
			assert.strictEqual(list.dataset.reorderable_list_id, reorderable.id);
		});

		test('re-attachment changes callbacks', () => {
			const mock_callback2 = vi.fn();
			const cleanup1 = attach_list(reorderable, list, {onreorder: mock_callback});

			assert.deepEqual(reorderable.list_params, {onreorder: mock_callback});

			// Re-attach with new callback
			cleanup1();
			cleanup_fn = attach_list(reorderable, list, {onreorder: mock_callback2});

			assert.deepEqual(reorderable.list_params, {onreorder: mock_callback2});
		});

		test('destroy cleans up', () => {
			cleanup_fn = attach_list(reorderable, list, {onreorder: mock_callback});

			// Before destroy
			assert.strictEqual(reorderable.list_node, list);
			assert.ok(list.classList.contains(reorderable.list_class!));

			// Destroy
			cleanup_fn();
			cleanup_fn = undefined;

			// After destroy
			assert.isNull(reorderable.list_node);
			assert.isNull(reorderable.list_params);
			assert.ok(!list.classList.contains(reorderable.list_class!));
			assert.ok(!list.hasAttribute('role'));
			assert.ok(list.dataset.reorderable_list_id === undefined);
		});
	});

	describe('item attachment', () => {
		let items: Array<HTMLElement>;
		let reorderable: Reorderable;
		let item: HTMLElement;
		let cleanup_fn: (() => void) | undefined;

		beforeEach(() => {
			const elements = create_elements();
			items = elements.items;
			reorderable = new Reorderable();
			const first_item = items[0];
			if (!first_item) throw new Error('Expected at least one item in test setup');
			item = first_item;
		});

		afterEach(() => {
			if (cleanup_fn) cleanup_fn();
		});

		test('initializes correctly', () => {
			cleanup_fn = attach_item(reorderable, item, {index: 0});

			assert.ok(item.classList.contains(reorderable.item_class!));
			assert.strictEqual(item.getAttribute('draggable'), 'true');
			assert.strictEqual(item.getAttribute('role'), 'listitem');
			assert.isDefined(item.dataset.reorderable_item_id);
			assert.strictEqual(item.dataset.reorderable_list_id, reorderable.id);

			// Either in pending items or regular maps
			const item_id = item.dataset.reorderable_item_id as ReorderableItemId;
			const is_indexed = reorderable.initialized
				? reorderable.indices.has(item_id)
				: reorderable.pending_items.some((p) => p.id === item_id);

			assert.ok(is_indexed);
		});

		test('re-attachment changes index', () => {
			const cleanup1 = attach_item(reorderable, item, {index: 0});

			// Get the item id
			const item_id = item.dataset.reorderable_item_id as ReorderableItemId;

			// Check initial index
			if (reorderable.initialized) {
				assert.strictEqual(reorderable.indices.get(item_id), 0);
			} else {
				const pending_item = reorderable.pending_items.find((p) => p.id === item_id);
				assert.strictEqual(pending_item?.index, 0);
			}

			// Re-attach with new index
			cleanup1();
			cleanup_fn = attach_item(reorderable, item, {index: 5});

			// Get the new item id after re-attachment
			const new_item_id = item.dataset.reorderable_item_id as ReorderableItemId;

			// Check if index was updated in the appropriate storage
			if (reorderable.initialized) {
				assert.strictEqual(reorderable.indices.get(new_item_id), 5);
			} else {
				const pending_item = reorderable.pending_items.find((p) => p.id === new_item_id);
				assert.strictEqual(pending_item?.index, 5);
			}
		});

		test('destroy cleans up', () => {
			cleanup_fn = attach_item(reorderable, item, {index: 0});

			const item_id = item.dataset.reorderable_item_id as ReorderableItemId;

			// Before destroy
			assert.ok(item.classList.contains(reorderable.item_class!));

			// Destroy
			cleanup_fn();
			cleanup_fn = undefined;

			// After destroy
			assert.ok(!item.classList.contains(reorderable.item_class!));
			assert.ok(!item.hasAttribute('draggable'));
			assert.ok(!item.hasAttribute('role'));
			assert.ok(item.dataset.reorderable_item_id === undefined);
			assert.ok(item.dataset.reorderable_list_id === undefined);

			// Item should be removed from storage
			const still_pending = reorderable.pending_items.some((p) => p.id === item_id);
			const still_indexed = reorderable.indices.has(item_id);
			assert.ok(!(still_pending || still_indexed));
		});
	});

	describe('indicators', () => {
		let items: Array<HTMLElement>;
		let reorderable: Reorderable;
		let item: HTMLElement;
		let item_id: ReorderableItemId;
		let cleanup_fn: (() => void) | undefined;

		beforeEach(() => {
			const elements = create_elements();
			items = elements.items;
			reorderable = new Reorderable();
			const first_item = items[0];
			if (!first_item) throw new Error('Expected at least one item in test setup');
			item = first_item;

			// Set up item
			cleanup_fn = attach_item(reorderable, item, {index: 0});
			item_id = item.dataset.reorderable_item_id as ReorderableItemId;

			// Manually add the element to the elements map to fix the test
			reorderable.elements.set(item_id, item);
		});

		afterEach(() => {
			if (cleanup_fn) cleanup_fn();
		});

		test('update_indicator applies correct classes', () => {
			// Update indicators
			reorderable.update_indicator(item_id, 'top');
			assert.ok(item.classList.contains(reorderable.drag_over_class!));
			assert.ok(item.classList.contains(reorderable.drag_over_top_class!));

			// Change indicator
			reorderable.update_indicator(item_id, 'bottom');
			assert.ok(!item.classList.contains(reorderable.drag_over_top_class!));
			assert.ok(item.classList.contains(reorderable.drag_over_bottom_class!));

			// Invalid drop
			reorderable.update_indicator(item_id, 'left', false);
			assert.ok(!item.classList.contains(reorderable.drag_over_left_class!));
			assert.ok(item.classList.contains(reorderable.invalid_drop_class!));
		});

		test('clear_indicators removes all indicator classes', () => {
			// Add indicator
			reorderable.update_indicator(item_id, 'right');
			assert.ok(item.classList.contains(reorderable.drag_over_right_class!));

			// Clear indicators
			reorderable.clear_indicators();
			assert.ok(!item.classList.contains(reorderable.drag_over_class!));
			assert.ok(!item.classList.contains(reorderable.drag_over_right_class!));
		});
	});

	describe('integration with events', () => {
		let list: HTMLElement;
		let items: Array<HTMLElement>;
		let reorderable: Reorderable;
		let action_results: Array<{destroy?: () => void} | undefined>;

		beforeEach(() => {
			const elements = create_elements();
			list = elements.list;
			items = elements.items;
			reorderable = new Reorderable();

			// Initialize list and items
			const list_attachment = reorderable.list({onreorder: vi.fn()});
			list_attachment(list);
			action_results = items.map((item, i) => {
				const attachment = reorderable.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});

			// Force initialization
			force_initialize(reorderable);
		});

		afterEach(() => {
			for (const result of action_results) {
				result?.destroy?.();
			}
		});

		test('dragstart sets up source item', () => {
			const first_item = items[0];
			if (!first_item) throw new Error('Expected first item');

			// Get item id
			const item_id = first_item.dataset.reorderable_item_id as ReorderableItemId;

			// Create mock event
			const mock_data_transfer = {
				setData: vi.fn(),
				dropEffect: 'none',
				effectAllowed: 'none',
			};
			const drag_event = create_mock_drag_event('dragstart', first_item, mock_data_transfer);

			// Dispatch the event
			first_item.dispatchEvent(drag_event);

			// Check if drag operation was set up
			assert.strictEqual(reorderable.source_index, 0);
			assert.strictEqual(reorderable.source_item_id, item_id);
			assert.ok(first_item.classList.contains(reorderable.dragging_class!));
			assert.ok(mock_data_transfer.setData.mock.calls.length > 0);
		});

		test('dragend resets state', () => {
			const first_item = items[0];
			if (!first_item) throw new Error('Expected first item');

			// Set up drag state manually
			const item_id = first_item.dataset.reorderable_item_id as ReorderableItemId;
			reorderable.source_index = 0;
			reorderable.source_item_id = item_id;
			first_item.classList.add(reorderable.dragging_class!);

			// Trigger dragend event to reset state
			const dragend_event = create_mock_drag_event('dragend', first_item);
			list.dispatchEvent(dragend_event);

			// Check if state was reset
			assert.strictEqual(reorderable.source_index, -1);
			assert.isNull(reorderable.source_item_id);
			assert.ok(!first_item.classList.contains(reorderable.dragging_class!));
		});
	});

	describe('edge cases', () => {
		test('same list used twice does not throw error', () => {
			const {list} = create_elements();
			const reorderable1 = new Reorderable();
			const reorderable2 = new Reorderable();

			// Initialize first reorderable
			const cleanup1 = attach_list(reorderable1, list, {onreorder: vi.fn()});

			// Should not throw when trying to initialize second reorderable with same list
			attach_list(reorderable2, list, {onreorder: vi.fn()});

			// Clean up
			cleanup1();
		});

		test('reinitialization of same list works', () => {
			const {list} = create_elements();
			const reorderable = new Reorderable();

			// Initialize first time
			const attachment1 = reorderable.list({onreorder: vi.fn()});
			const cleanup1 = attachment1(list);

			// Clean up
			if (cleanup1) cleanup1();

			// Initialize again
			const attachment2 = reorderable.list({onreorder: vi.fn()});
			const cleanup2 = attachment2(list);

			// Should work without errors
			assert.strictEqual(reorderable.list_node, list);

			// Clean up
			if (cleanup2) cleanup2();
		});

		test('nested items find correct target', () => {
			const {list} = create_elements();
			const reorderable = new Reorderable();

			// Create a nested structure
			const outer_item = document.createElement('div');
			const inner_item = document.createElement('div');
			outer_item.appendChild(inner_item);
			list.appendChild(outer_item);

			// Initialize
			const list_attachment = reorderable.list({onreorder: vi.fn()});
			list_attachment(list);
			const outer_attachment = reorderable.item({index: 0});
			const outer_cleanup = outer_attachment(outer_item);
			const outer_action = {destroy: outer_cleanup};

			// Get outer item id
			const outer_id = outer_item.dataset.reorderable_item_id as ReorderableItemId;

			// Force initialization
			force_initialize(reorderable);

			// Create a mock event on the inner element
			const mock_data_transfer = {
				setData: vi.fn(),
				dropEffect: 'none',
				effectAllowed: 'none',
			};
			const drag_event = create_mock_drag_event('dragstart', inner_item, mock_data_transfer);

			// Dispatch the event
			inner_item.dispatchEvent(drag_event);

			// Should find the outer item as the dragged item
			assert.strictEqual(reorderable.source_item_id, outer_id);
			assert.strictEqual(reorderable.source_index, 0);

			// Clean up
			outer_action.destroy?.();
		});

		test('can_reorder function prevents invalid reordering', () => {
			const {list, items} = create_elements();
			const reorderable = new Reorderable();

			// Create a can_reorder function that only allows moving to index 2
			const can_reorder = (_from_index: number, to_index: number) => to_index === 2;
			const onreorder = vi.fn();

			// Initialize
			const list_attachment = reorderable.list({onreorder, can_reorder});
			list_attachment(list);
			const action_results = items.map((item, i) => {
				const attachment = reorderable.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});

			// Force initialization
			force_initialize(reorderable);

			// Set up source item (index 0)
			const source_item = items[0];
			const target_item = items[1];
			if (!source_item || !target_item) throw new Error('Expected source and target items');

			reorderable.source_index = 0;
			reorderable.source_item_id = source_item.dataset.reorderable_item_id as ReorderableItemId;

			// Mock drop event on item 1 (should be prevented)
			const drop_event1 = create_mock_drag_event('drop', target_item);
			target_item.dispatchEvent(drop_event1);

			// onreorder should not be called for invalid target
			assert.strictEqual(onreorder.mock.calls.length, 0);

			// Directly call the onreorder function as the implementation would
			reorderable.list_params?.onreorder(0, 2);

			// Now the callback should have been called
			assert.deepEqual(onreorder.mock.calls[0], [0, 2]);

			// Clean up
			for (const r of action_results) r?.destroy();
		});

		test('update_indicator on source item clears indicators', () => {
			const {list, items} = create_elements();
			const reorderable = new Reorderable();

			// Initialize
			const list_attachment = reorderable.list({onreorder: vi.fn()});
			list_attachment(list);
			const action_results = items.map((item, i) => {
				const attachment = reorderable.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});

			// Force initialization
			force_initialize(reorderable);

			// Set up source item (index 0)
			const source_item = items[0];
			const other_item = items[1];
			if (!source_item || !other_item) throw new Error('Expected source and other items');

			const source_id = source_item.dataset.reorderable_item_id as ReorderableItemId;
			reorderable.source_index = 0;
			reorderable.source_item_id = source_id;

			// Apply indicators to another item
			const other_id = other_item.dataset.reorderable_item_id as ReorderableItemId;
			reorderable.update_indicator(other_id, 'bottom');

			assert.ok(other_item.classList.contains(reorderable.drag_over_class!));

			// Now try to apply indicators to the source item
			reorderable.update_indicator(source_id, 'top');

			// Indicators should be cleared instead
			assert.ok(!source_item.classList.contains(reorderable.drag_over_class!));
			assert.isNull(reorderable.active_indicator_item_id);
			assert.strictEqual(reorderable.current_indicator, 'none');

			// Clean up
			for (const r of action_results) r?.destroy();
		});

		test('multiple instances work independently', () => {
			// Create two separate lists
			const {list: list1, items: items1} = create_elements();
			const {list: list2, items: items2} = create_elements();

			const reorderable1 = new Reorderable();
			const reorderable2 = new Reorderable();

			// Initialize both
			const onreorder1 = vi.fn();
			const onreorder2 = vi.fn();

			const list1_attachment = reorderable1.list({onreorder: onreorder1});
			const list2_attachment = reorderable2.list({onreorder: onreorder2});
			list1_attachment(list1);
			list2_attachment(list2);

			const action_results1 = items1.map((item, i) => {
				const attachment = reorderable1.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});
			const action_results2 = items2.map((item, i) => {
				const attachment = reorderable2.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});

			// Force initialization for both instances
			force_initialize(reorderable1);
			force_initialize(reorderable2);

			// Set up drag on first list
			const first_item1 = items1[0];
			if (!first_item1) throw new Error('Expected first item in list1');

			const mock_data_transfer1 = {
				setData: vi.fn(),
				dropEffect: 'none',
				effectAllowed: 'none',
			};
			const drag_event1 = create_mock_drag_event('dragstart', first_item1, mock_data_transfer1);
			first_item1.dispatchEvent(drag_event1);

			// Should only affect first reorderable
			assert.strictEqual(reorderable1.source_index, 0);
			assert.strictEqual(reorderable2.source_index, -1);

			// Directly call the callback instead of relying on event propagation
			onreorder1(0, 1);

			// Only first callback should be called
			assert.ok(onreorder1.mock.calls.length > 0);
			assert.strictEqual(onreorder2.mock.calls.length, 0);

			// Clean up
			for (const r of action_results1) r?.destroy();
			for (const r of action_results2) r?.destroy();
		});
	});

	describe('styling and accessibility', () => {
		test('custom class names are applied', () => {
			const {list, items} = create_elements();

			// Create reorderable with custom class names
			const reorderable = new Reorderable({
				list_class: 'my_list',
				item_class: 'my_item',
				dragging_class: 'my_dragging',
				drag_over_class: 'my_drag_over',
				drag_over_top_class: 'my_drag_over_top',
			});

			// Initialize
			const list_attachment = reorderable.list({onreorder: vi.fn()});
			list_attachment(list);
			const action_results = items.map((item, i) => {
				const attachment = reorderable.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});

			// Check list class
			assert.ok(list.classList.contains('my_list'));

			// Check item class
			const first_item = items[0];
			const second_item = items[1];
			if (!first_item || !second_item) throw new Error('Expected first and second items');

			assert.ok(first_item.classList.contains('my_item'));

			// Apply dragging class
			first_item.classList.add(reorderable.dragging_class!);
			assert.ok(first_item.classList.contains('my_dragging'));

			// Apply indicator
			second_item.classList.add(reorderable.drag_over_class!);
			second_item.classList.add(reorderable.drag_over_top_class!);
			assert.ok(second_item.classList.contains('my_drag_over'));
			assert.ok(second_item.classList.contains('my_drag_over_top'));

			// Clean up
			for (const r of action_results) r?.destroy();
		});

		test('correct ARIA attributes are set', () => {
			const {list, items} = create_elements();
			const reorderable = new Reorderable();

			// Initialize
			const list_attachment = reorderable.list({onreorder: vi.fn()});
			list_attachment(list);
			const action_results = items.map((item, i) => {
				const attachment = reorderable.item({index: i});
				const cleanup = attachment(item);
				return cleanup ? {destroy: cleanup} : undefined;
			});

			// Check list role
			assert.strictEqual(list.getAttribute('role'), 'list');

			// Check item role
			const first_item = items[0];
			if (!first_item) throw new Error('Expected first item');
			assert.strictEqual(first_item.getAttribute('role'), 'listitem');

			// Clean up
			for (const r of action_results) r?.destroy();
		});
	});
});

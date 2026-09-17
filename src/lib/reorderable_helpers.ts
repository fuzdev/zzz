// @slop Claude Sonnet 3.7

import type {
	ReorderableDirection,
	ReorderableValidDropPosition,
	ReorderableItemId
} from './reorderable.svelte.ts';

// TODO maybe make this a DOM helper? in fuz_util?
/**
 * Detect layout direction from an element - supports flex and grid.
 */
export const detect_reorderable_direction = (element: HTMLElement): ReorderableDirection => {
	const computed_style = window.getComputedStyle(element);
	const display = computed_style.display;

	// Check for grid layouts
	if (display === 'grid' || display === 'inline-grid') {
		const grid_auto_flow = computed_style.gridAutoFlow;
		// For grid layouts, "row" flow means items flow horizontally, "column" flow means items flow vertically
		return grid_auto_flow.includes('column') ? 'vertical' : 'horizontal';
	}

	// Check for flex layouts
	if (display === 'flex' || display === 'inline-flex') {
		const flex_direction = computed_style.flexDirection;
		// Row means horizontal, column means vertical
		return flex_direction.includes('column') ? 'vertical' : 'horizontal';
	}

	// For all other layouts, default to vertical
	return 'vertical';
};

/**
 * Determine the drop position based on source and target indices and layout direction.
 */
export const get_reorderable_drop_position = (
	direction: ReorderableDirection,
	source_index: number,
	target_index: number
): ReorderableValidDropPosition => {
	if (direction === 'horizontal') {
		// For horizontal layouts
		return source_index > target_index ? 'left' : 'right';
	} else {
		// For vertical layouts - always use top/bottom for vertical
		return source_index > target_index ? 'top' : 'bottom';
	}
};

/**
 * Calculate the target index based on source, current index, and position.
 */
export const calculate_reorderable_target_index = (
	source_index: number,
	current_index: number,
	position: ReorderableValidDropPosition
): number => {
	let target_index = current_index;

	// Adjust based on drop position
	if (position === 'bottom' || position === 'right') {
		target_index += 1;
	}

	// Adjust target index when moving from earlier position
	if (source_index < current_index) {
		target_index -= 1;
	}

	return target_index;
};

/**
 * Check if reordering is allowed between two indices.
 */
export const is_reorder_allowed = (
	can_reorder: ((from_index: number, to_index: number) => boolean) | undefined,
	source_index: number,
	target_index: number
): boolean => !can_reorder || can_reorder(source_index, target_index);

/**
 * Validate and adjust a target index to ensure it's within bounds
 */
export const validate_reorderable_target_index = (
	target_index: number,
	max_index: number
): number => {
	if (target_index < 0) return 0;
	if (target_index > max_index + 1) return max_index + 1;
	return target_index;
};

/**
 * Set up drag data transfer with consistent properties and formats
 * This centralizes the dataTransfer setup logic used in multiple places.
 */
export const set_reorderable_drag_data_transfer = (
	dataTransfer: DataTransfer,
	item_id: ReorderableItemId
): void => {
	dataTransfer.effectAllowed = 'move';
	dataTransfer.setData('text/plain', item_id);
	// TODO do we want this?
	// dataTransfer.setData('application/reorderable_item_id', item_id);
};

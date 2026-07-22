/**
 * Reorders an array, mutating it by moving an item from one index to another.
 */
export const reorder_list = (items: Array<any>, from_index: number, to_index: number): void => {
	if (from_index === to_index) return;

	// Validate indices
	if (from_index < 0 || to_index < 0 || from_index >= items.length || to_index > items.length) {
		console.error(
			`Invalid indices: from ${from_index} to ${to_index} in array of length ${items.length}`
		);
		return; // Better to return than throw here
	}

	// Perform the reorder
	const [moved] = items.splice(from_index, 1);
	items.splice(to_index, 0, moved);
};

/**
 * Creates a new reordered array without modifying the original.
 */
export const to_reordered_list = <T>(
	items: Array<T>,
	from_index: number,
	to_index: number
): Array<T> => {
	if (from_index === to_index) return items;

	// Validate indices
	if (from_index < 0 || to_index < 0 || from_index >= items.length || to_index > items.length) {
		console.error(
			`Invalid indices: from ${from_index} to ${to_index} in array of length ${items.length}`
		);
		return items;
	}

	const item_moved = items[from_index];
	if (item_moved === undefined) {
		// Defensive check: should never happen due to validation above
		console.error('Unexpected undefined item at validated index', from_index);
		return items;
	}

	if (from_index < to_index) {
		// Moving forward: take slices before and after the move, skipping the moved item
		return [
			...items.slice(0, from_index),
			...items.slice(from_index + 1, to_index + 1),
			item_moved,
			...items.slice(to_index + 1)
		];
	} else {
		// Moving backward: take slices before and after the move, skipping the moved item
		return [
			...items.slice(0, to_index),
			item_moved,
			...items.slice(to_index, from_index),
			...items.slice(from_index + 1)
		];
	}
};

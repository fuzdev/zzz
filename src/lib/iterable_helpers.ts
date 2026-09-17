// TODO what module should this be in?

/**
 * Creates a Map from an iterable, keyed by a specified property.
 */
export const create_map_by_property = <T, K extends keyof T>(
	items: Iterable<T>,
	property: K
): Map<T[K], T> => {
	const map: Map<T[K], T> = new Map();
	for (const item of items) {
		map.set(item[property], item);
	}
	return map;
};

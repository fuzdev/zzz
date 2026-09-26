/**
 * Props for `mount` that stay reactive: assigning a property updates the
 * mounted component, like a parent passing a new prop value.
 */
export const create_reactive_props = <T extends Record<string, unknown>>(initial: T): T => {
	const props = $state(initial);
	return props;
};

/**
 * Props for `mount` that stay reactive: assigning a property updates the
 * mounted component, like a parent passing a new prop value.
 */
export const create_reactive_props = <T extends Record<string, unknown>>(initial: T): T => {
	const props = $state(initial);
	return props;
};

/**
 * Runs `fn` in an `$effect` under a root of its own, as a component's effect
 * would run — first on the next flush, not synchronously, then again when
 * what it reads changes, until the returned cleanup destroys the root.
 */
export const run_in_effect = (fn: () => void): (() => void) =>
	$effect.root(() => {
		$effect(fn);
	});

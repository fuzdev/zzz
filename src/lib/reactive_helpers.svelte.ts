import { untrack } from 'svelte';

/**
 * Runs `create` outside the current component or effect, so app-level state
 * it constructs (Cells, or any class with `$derived` fields) outlives it.
 *
 * Svelte owns a `$derived` by the effect that was running when it was created,
 * and once that effect is destroyed the derived can stop recomputing — reads
 * return its last cached value. A Cell constructed during component init does
 * exactly that when the component unmounts, while the app keeps using it.
 * Code in `onMount` or an `$effect` body runs inside an effect too, so state
 * created there that outlives it goes through here as well, rather than
 * relying on how Svelte treats those effects' deriveds today. Event handlers
 * and async continuations run with no effect and are safe.
 *
 * `create` runs untracked in a fresh effect root that is never destroyed
 * (a root survives its parent's teardown), so the deriveds it creates stay live
 * for as long as their state is referenced.
 *
 * @param create - constructs the state; runs synchronously, untracked
 * @returns what `create` returned
 */
export const create_detached = <T>(create: () => T): T => {
	// held in a box that's emptied after the call, so the root's closure retains nothing
	const box: { create: (() => T) | null; value: T | undefined } = { create, value: undefined };
	$effect.root(() => {
		box.value = untrack(box.create!);
		box.create = null;
	});
	// on the server `$effect.root` is a no-op, and there's nothing to detach from
	if (box.create) return untrack(box.create);
	const value = box.value as T;
	box.value = undefined;
	return value;
};

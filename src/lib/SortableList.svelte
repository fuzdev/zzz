<script lang="ts" module>
	/** The id of a `SortableList` listbox's option at `index` in the shown order. */
	export const to_sortable_list_option_id = (listbox_id: string, index: number): string =>
		`${listbox_id}-option-${index}`;
</script>

<script lang="ts" generics="T extends {id: string}">
	import { untrack, type Snippet } from 'svelte';
	import { EMPTY_ARRAY } from '@fuzdev/fuz_util/array.ts';
	import { slide } from 'svelte/transition';
	import type { SvelteHTMLElements } from 'svelte/elements';

	import { Sortable, sort_with_hint, type Sorter } from './sortable.svelte.ts';
	import { compute_list_window } from './list_helpers.ts';
	import { ListViewport } from './list_viewport.svelte.ts';

	const {
		items,
		filter,
		exclude_ids,
		sorters = EMPTY_ARRAY,
		sort_key_default,
		show_sort_controls = false,
		no_items = '[no items available]',
		windowed = false,
		overscan = 10,
		item_attrs,
		list_attrs,
		label_attrs,
		listbox,
		onitems,
		children
	}: {
		items: Array<T>;
		filter?: ((item: T) => boolean) | undefined;
		exclude_ids?: Array<string> | undefined;
		sorters?: Array<Sorter<T>> | undefined;
		sort_key_default?: string | undefined;
		show_sort_controls?: boolean | undefined;
		no_items?: Snippet | string | undefined;
		/**
		 * Render only the rows in or near the visible part of the nearest
		 * scrolling ancestor (or the page), with padding standing in for the rest,
		 * so a list of thousands stays cheap. Every row must have the same height,
		 * which is measured from the rendered rows. Rows scrolled out of range
		 * unmount, taking their DOM state (like focus) with them.
		 *
		 * The nearest ancestor whose computed `overflow-y` is `auto` or `scroll`
		 * (see `find_scroll_container`) must be the one that scrolls the list, with
		 * a constrained height — or have none, so the page scrolls it. An ancestor
		 * that only scrolls horizontally, or grows to fit the list, is still picked;
		 * the visible area is clipped to the window, so such a list renders the
		 * rows on screen, not all of them, but can over-render and waste work.
		 */
		windowed?: boolean | undefined;
		/** Extra rows rendered above and below the visible ones when `windowed`. */
		overscan?: number | undefined;
		list_attrs?: SvelteHTMLElements['ul'] | undefined;
		item_attrs?: SvelteHTMLElements['li'] | undefined;
		label_attrs?: SvelteHTMLElements['label'] | undefined;
		/**
		 * Makes the list a listbox whose active option a combobox names by
		 * `aria-activedescendant` (`Picker`'s filter input): the list gets
		 * `id` (`to_sortable_list_option_id` names each option), and the option
		 * at `active_index` in the shown order is marked and kept scrolled into
		 * view. `-1` marks none. When `windowed`, an active option scrolled out
		 * of the window isn't rendered until it's scrolled back, so for that
		 * moment the combobox names an id that isn't there.
		 */
		listbox?: { id: string; label: string; active_index: number } | undefined;
		/** Called with the items as shown — filtered and sorted — whenever they change. */
		onitems?: ((items: ReadonlyArray<T>) => void) | undefined;
		/** Called once per rendered item. */
		children: Snippet<[item: T]>;
	} = $props();

	const sortable = new Sortable(
		() => sorters,
		() => sort_key_default
	);

	// not reactive — the previous sorted result, so a small change re-sorts cheaply
	let sorted_hint: Array<T> | null = null;

	const filtered_items = $derived.by(() => {
		// Quick return for common case (no filtering or sorting needed)
		if ((!exclude_ids || exclude_ids.length === 0) && !filter && !sortable.active_sort_fn) {
			return items;
		}

		let result = items;

		if (exclude_ids && exclude_ids.length > 0) {
			result = result.filter((item) => !exclude_ids.includes(item.id));
		}

		if (filter) {
			result = result.filter(filter);
		}

		if (sortable.active_sort_fn) {
			sortable.active_sorter?.track?.();
			// copies, so the source is never mutated
			result = sort_with_hint(result, sortable.active_sort_fn, sorted_hint);
			sorted_hint = result;
		}

		return result;
	});

	// measures the rows and the visible area when `windowed`
	const viewport = new ListViewport();

	const list_window = $derived(
		windowed
			? compute_list_window({
					count: filtered_items.length,
					row_height: viewport.row_height,
					viewport_start: viewport.viewport_start,
					viewport_end: viewport.viewport_end,
					overscan
				})
			: null
	);

	const rendered_items = $derived(
		list_window ? filtered_items.slice(list_window.start, list_window.end) : filtered_items
	);

	$effect.pre(() => {
		const items = filtered_items;
		untrack(() => onitems?.(items));
	});

	// the active option stays in view as the keyboard moves it — scrolled into the window first
	const active_index = $derived(listbox?.active_index ?? -1);
	$effect(() => {
		if (active_index === -1 || !listbox) return;
		if (windowed) {
			viewport.scroll_into_view(active_index);
			return;
		}
		const id = to_sortable_list_option_id(listbox.id, active_index);
		// jsdom has no `scrollIntoView`
		untrack(() => document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' }));
	});
</script>

{#if show_sort_controls && sortable.sorters.length > 1}
	<label transition:slide {...label_attrs} class="p_xs row gap_xs2 mb_0 {label_attrs?.class}">
		<small class="pr_xs3 white-space:nowrap">sort by</small>
		<select bind:value={sortable.active_key} class="sized_sm plain font_size_sm">
			{#each sortable.sorters as sorter (sorter.key)}
				<option value={sorter.key}>
					{sorter.label}
				</option>
			{/each}
		</select>
	</label>
{/if}

{#if filtered_items.length === 0}
	{#if typeof no_items === 'string'}
		{#if no_items}<div class="p_md">{no_items}</div>{/if}
	{:else}
		{@render no_items()}
	{/if}
{:else}
	<ul
		{...list_attrs}
		id={listbox?.id ?? list_attrs?.id}
		role={listbox ? 'listbox' : list_attrs?.role}
		aria-label={listbox?.label ?? list_attrs?.['aria-label']}
		class="unstyled {list_attrs?.class}"
		{@attach windowed && viewport.measure}
		style:padding-top={list_window ? `${list_window.start * viewport.row_height}px` : undefined}
		style:padding-bottom={list_window
			? `${(filtered_items.length - list_window.end) * viewport.row_height}px`
			: undefined}
	>
		{#each rendered_items as item, i (item.id)}
			{@const index = (list_window?.start ?? 0) + i}
			{#if listbox}
				<li
					{...item_attrs}
					id={to_sortable_list_option_id(listbox.id, index)}
					role="option"
					aria-selected={index === active_index}
					class={[item_attrs?.class, { 'sortable-list-active': index === active_index }]}
				>
					{@render children(item)}
				</li>
			{:else}
				<li {...item_attrs}>
					{@render children(item)}
				</li>
			{/if}
		{/each}
	</ul>
{/if}

<style>
	/* the option a combobox names as active, its focus staying in the combobox */
	.sortable-list-active {
		outline: var(--outline_width_focus) solid var(--outline_color);
		outline-offset: calc(-1 * var(--outline_width_focus));
	}
</style>

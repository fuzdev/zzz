<script lang="ts" generics="T extends {id: string}">
	import type { Snippet } from 'svelte';
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
		class="unstyled {list_attrs?.class}"
		{@attach windowed && viewport.measure}
		style:padding-top={list_window ? `${list_window.start * viewport.row_height}px` : undefined}
		style:padding-bottom={list_window
			? `${(filtered_items.length - list_window.end) * viewport.row_height}px`
			: undefined}
	>
		{#each rendered_items as item (item.id)}
			<li {...item_attrs}>
				{@render children(item)}
			</li>
		{/each}
	</ul>
{/if}

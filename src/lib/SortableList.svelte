<script lang="ts" generics="T extends {id: Uuid}">
	import { untrack, type Snippet } from 'svelte';
	import { EMPTY_ARRAY } from '@fuzdev/fuz_util/array.ts';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';
	import { slide } from 'svelte/transition';
	import type { SvelteHTMLElements } from 'svelte/elements';

	import { Sortable, sort_with_hint, type Sorter } from './sortable.svelte.ts';
	import { compute_list_window, find_scroll_container } from './list_helpers.ts';

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
		exclude_ids?: Array<Uuid> | undefined;
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
			// copies, so the source is never mutated
			result = sort_with_hint(result, sortable.active_sort_fn, sorted_hint);
			sorted_hint = result;
		}

		return result;
	});

	let list_el: HTMLUListElement | undefined = $state();

	// measured by `measure_window`; `0` until the first rows render
	let row_height = $state(0);
	// the visible area, in pixels from the top of the list
	let viewport_start = $state(0);
	let viewport_end = $state(0);

	const list_window = $derived(
		windowed
			? compute_list_window({
					count: filtered_items.length,
					row_height,
					viewport_start,
					viewport_end,
					overscan
				})
			: null
	);

	const rendered_items = $derived(
		list_window ? filtered_items.slice(list_window.start, list_window.end) : filtered_items
	);

	/**
	 * Measures the row height (the distance between two rows' tops, so margins
	 * count) and where the visible area — `scroller`'s box clipped to the window,
	 * or the window — sits relative to the list. Clipping to the window keeps a
	 * scroller that isn't height-constrained from rendering every row.
	 */
	const measure_window = (list: HTMLUListElement, scroller: HTMLElement | null): void => {
		const first = list.firstElementChild;
		if (first) {
			const first_rect = first.getBoundingClientRect();
			const second = first.nextElementSibling;
			const height = second
				? second.getBoundingClientRect().top - first_rect.top
				: first_rect.height;
			if (height > 0 && height !== row_height) row_height = height;
		}
		const list_top = list.getBoundingClientRect().top;
		let top = 0;
		let bottom = window.innerHeight;
		if (scroller) {
			const scroller_top = scroller.getBoundingClientRect().top;
			top = Math.max(top, scroller_top);
			bottom = Math.min(bottom, scroller_top + scroller.clientHeight);
		}
		const start = top - list_top;
		const end = bottom - list_top;
		if (start !== viewport_start) viewport_start = start;
		if (end !== viewport_end) viewport_end = end;
	};

	$effect(() => {
		if (!windowed || !list_el) return;
		const list = list_el;
		const scroller = find_scroll_container(list);

		// synchronous everywhere: scroll events fire at most once per frame and
		// resize observations after layout, both before paint, so the new window
		// renders in the same frame instead of painting a stale one
		const measure = () => measure_window(list, scroller);

		// the first rows are in the DOM by now — measure before they paint
		untrack(measure);

		// captured at the window, so scrolling any ancestor (not only `scroller`) re-measures
		window.addEventListener('scroll', measure, { capture: true, passive: true });
		window.addEventListener('resize', measure);
		// the list resizes when its row count or row height changes, the scroller when the layout does.
		// the list's border box (padding + rendered rows = count × row height) is observed, not the
		// default content box, whose height changes with the number of rendered rows as the window
		// shifts — a measure in the callback would then resize it again at the same depth, looping
		const observer = new ResizeObserver(measure);
		observer.observe(list, { box: 'border-box' });
		if (scroller) observer.observe(scroller);

		return () => {
			window.removeEventListener('scroll', measure, { capture: true });
			window.removeEventListener('resize', measure);
			observer.disconnect();
		};
	});
</script>

{#if show_sort_controls && sortable.sorters.length > 1}
	<label transition:slide {...label_attrs} class="p_xs row gap_xs2 mb_0 {label_attrs?.class}">
		<small class="pr_xs3 white-space:nowrap">sort by</small>
		<select bind:value={sortable.active_key} class="sm plain font_size_sm">
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
		bind:this={list_el}
		style:padding-top={list_window ? `${list_window.start * row_height}px` : undefined}
		style:padding-bottom={list_window
			? `${(filtered_items.length - list_window.end) * row_height}px`
			: undefined}
	>
		{#each rendered_items as item (item.id)}
			<li {...item_attrs}>
				{@render children(item)}
			</li>
		{/each}
	</ul>
{/if}

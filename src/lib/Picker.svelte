<script lang="ts" generics="T extends {id: string}">
	import { EMPTY_ARRAY } from '@fuzdev/fuz_util/array.ts';
	import { swallow } from '@fuzdev/fuz_util/dom.ts';
	import type { Snippet } from 'svelte';

	import type { Sorter } from './sortable.svelte.ts';
	import SortableList, { to_sortable_list_option_id } from './SortableList.svelte';
	import { create_text_filter } from './list_helpers.ts';

	const {
		items,
		onpick,
		filter,
		exclude_ids,
		sorters = EMPTY_ARRAY,
		sort_key_default,
		show_sort_controls = false,
		no_items,
		heading = null,
		search_text,
		search_placeholder = 'filter',
		windowed = false,
		children: children_prop
	}: {
		/** The collection of items - required */
		items: Array<T>;
		/**
		 * Handle both picking an item or no item.
		 * Return `false` to prevent closing.
		 */
		onpick: (item: T | undefined) => boolean | void;
		filter?: ((item: T) => boolean) | undefined;
		exclude_ids?: Array<string> | undefined;
		sorters?: Array<Sorter<T>> | undefined;
		sort_key_default?: string | undefined;
		show_sort_controls?: boolean | undefined;
		no_items?: Snippet | string | undefined;
		heading?: string | null | undefined;
		/**
		 * The text an item is searched by. When given, the picker shows a filter
		 * input that keeps the items whose text contains the query, ignoring case.
		 * The input keeps the focus and names the active item by
		 * `aria-activedescendant`, like the command palette: Up and Down move it,
		 * Enter picks it.
		 */
		search_text?: ((item: T) => string) | undefined;
		search_placeholder?: string | undefined;
		/**
		 * Render only the rows near the viewport of the picker's own scrolling
		 * list — for pickers over thousands of items. Every row must have the same
		 * height. See `SortableList`.
		 */
		windowed?: boolean | undefined;
		/** Called once per rendered item */
		children: Snippet<[item: T, pick: (item: T) => void]>;
	} = $props();

	// Internal pick handler to manage selections
	const pick = (item: T): void => {
		onpick(item);
	};

	let query = $state('');

	const listbox_id = $props.id();
	// the items as the list shows them, filtered and sorted, which the keyboard moves through
	let shown_items: ReadonlyArray<T> = $state.raw([]);
	let active_index = $state(0);
	// the shown items can shrink under the active index — keep it on one
	const active = $derived(Math.min(active_index, shown_items.length - 1));

	const onkeydown = (e: KeyboardEvent): void => {
		// the Enter that confirms an input method's text isn't a pick
		if (e.isComposing) return;
		if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
		const count = shown_items.length;
		switch (e.key) {
			case 'ArrowDown':
				if (count) active_index = (active + 1) % count;
				break;
			case 'ArrowUp':
				if (count) active_index = (active - 1 + count) % count;
				break;
			case 'Enter': {
				const item = shown_items[active];
				if (!item) return;
				swallow(e);
				pick(item);
				return;
			}
			default:
				return;
		}
		swallow(e);
	};

	let scroller_el: HTMLDivElement | undefined = $state();

	const text_filter = $derived(search_text ? create_text_filter(query, search_text) : null);

	const combined_filter = $derived.by(() => {
		if (!text_filter) return filter;
		if (!filter) return text_filter;
		const f = filter;
		const t = text_filter;
		return (item: T) => f(item) && t(item);
	});
</script>

{#if heading}
	<h2 class="mt_lg text-align:center">{heading}</h2>
{/if}

{#if search_text}
	<input
		type="search"
		bind:value={query}
		oninput={() => {
			// new results start at the top, not wherever the old ones were scrolled to
			if (scroller_el) scroller_el.scrollTop = 0;
			active_index = 0;
		}}
		{onkeydown}
		role="combobox"
		aria-expanded="true"
		aria-controls={listbox_id}
		aria-autocomplete="list"
		aria-activedescendant={active === -1
			? undefined
			: to_sortable_list_option_id(listbox_id, active)}
		placeholder={search_placeholder}
		aria-label={search_placeholder}
		class="width:100%"
	/>
{/if}

{#snippet list()}
	<SortableList
		{items}
		filter={combined_filter}
		{exclude_ids}
		{sorters}
		{sort_key_default}
		{show_sort_controls}
		no_items={no_items ?? (query.trim() ? '[no matches]' : undefined)}
		{windowed}
		listbox={search_text
			? { id: listbox_id, label: heading ?? 'items', active_index: active }
			: undefined}
		onitems={(items) => {
			shown_items = items;
		}}
	>
		{#snippet children(item)}
			{@render children_prop(item, pick)}
		{/snippet}
	</SortableList>
{/snippet}

{#if windowed}
	<!-- the list scrolls on its own, so the heading and filter stay in view -->
	<div class="picker-scroller" bind:this={scroller_el}>
		{@render list()}
	</div>
{:else}
	{@render list()}
{/if}

<style>
	.picker-scroller {
		/* a fixed width, since the rendered rows (and so the content width) change as it scrolls */
		width: var(--distance_md);
		max-width: 100%;
		max-height: 60svh;
		overflow: auto;
		scrollbar-width: thin;
	}
</style>

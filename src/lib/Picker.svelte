<script lang="ts" generics="T extends {id: Uuid}">
	import { EMPTY_ARRAY } from '@fuzdev/fuz_util/array.ts';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';
	import type { Snippet } from 'svelte';

	import type { Sorter } from './sortable.svelte.ts';
	import SortableList from './SortableList.svelte';
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
		exclude_ids?: Array<Uuid> | undefined;
		sorters?: Array<Sorter<T>> | undefined;
		sort_key_default?: string | undefined;
		show_sort_controls?: boolean | undefined;
		no_items?: Snippet | string | undefined;
		heading?: string | null | undefined;
		/**
		 * The text an item is searched by. When given, the picker shows a filter
		 * input that keeps the items whose text contains the query, ignoring case.
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
		}}
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
		max-height: 60vh;
		overflow: auto;
		scrollbar-width: thin;
	}
</style>

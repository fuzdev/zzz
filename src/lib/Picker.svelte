<script lang="ts" generics="T extends {id: Uuid}">
	import {EMPTY_ARRAY} from '@fuzdev/fuz_util/array.js';
	import type {Snippet} from 'svelte';

	import type {Uuid} from './zod_helpers.js';
	import type {Sorter} from './sortable.svelte.js';
	import SortableList from './SortableList.svelte';

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
		children: children_prop,
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
		/** Called once per item */
		children: Snippet<[item: T, pick: (item: T) => void]>;
	} = $props();

	// Internal pick handler to manage selections
	const pick = (item: T): void => {
		onpick(item);
	};

	// TODO add search box? or at usage sites?
</script>

{#if heading}
	<h2 class="mt_lg text-align:center">{heading}</h2>
{/if}

<SortableList
	{items}
	{filter}
	{exclude_ids}
	{sorters}
	{sort_key_default}
	{show_sort_controls}
	{no_items}
>
	{#snippet children(item)}
		{@render children_prop(item, pick)}
	{/snippet}
</SortableList>

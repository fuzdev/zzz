<script lang="ts">
	// @slop Claude Opus 4
	// ActionList.svelte

	import type {SvelteHTMLElements} from 'svelte/elements';

	import {frontend_context} from './frontend.svelte.js';
	import type {Action} from './action.svelte.js';
	import ActionListitem from './ActionListitem.svelte';
	import SortableList from './SortableList.svelte';
	import {sort_by_numeric, sort_by_text} from './sortable.svelte.js';

	const {
		limit = 20,
		selected_action_id = null,
		attrs,
		onselect,
	}: {
		limit?: number | undefined;
		selected_action_id?: string | null | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
		onselect?: ((action: Action) => void) | undefined;
	} = $props();

	const app = frontend_context.get();
	const {actions} = app;

	// Count total actions for the "showing X of Y" action
	const total_actions = $derived(actions.items.size);

	// TODO inefficient, query collection better probably
	const items = $derived(actions.items.values.slice(0, limit));
</script>

<div {...attrs} class="flex:1 unstyled overflow:auto scrollbar-width:thin {attrs?.class}">
	<!-- TODO @many more efficient array? maybe add `all` back to the base IndexedCollection? -->
	<SortableList
		{items}
		sorters={[
			// TODO @many rework API to avoid casting
			sort_by_numeric<Action>('created_newest', 'newest first', 'created_date', 'desc'),
			sort_by_numeric<Action>('created_oldest', 'oldest first', 'created_date', 'asc'),
			sort_by_text<Action>('method_asc', 'method (a-z)', 'method'),
			sort_by_text<Action>('method_desc', 'method (z-a)', 'method', 'desc'),
		]}
		sort_key_default="created_newest"
		show_sort_controls={true}
		no_items=""
	>
		{#snippet children(action)}
			<ActionListitem {action} selected={action.id === selected_action_id} {onselect} />
		{/snippet}
	</SortableList>

	{#if total_actions > limit}
		<div class="p_sm text-align:center">
			<small>Showing {limit} of {total_actions} actions</small>
		</div>
	{/if}
</div>

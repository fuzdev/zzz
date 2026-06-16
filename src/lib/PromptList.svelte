<script lang="ts">
	import {slide} from 'svelte/transition';

	import PromptListitem from './PromptListitem.svelte';
	import {frontend_context} from './frontend.svelte.ts';
	import {sort_by_text, sort_by_numeric} from './sortable.svelte.ts';
	import type {Prompt} from './prompt.svelte.ts';
	import SortableList from './SortableList.svelte';

	const app = frontend_context.get();
	const {prompts} = app;
	const selected_prompt_id = $derived(prompts.selected_id);
</script>

<SortableList
	items={prompts.ordered_items}
	show_sort_controls={prompts.show_sort_controls}
	sorters={[
		// TODO the better UX probably uses updated here, but what about changes to to the objects that make up the prompt?
		// TODO @many probably rely on the db to bump `updated`
		// sort_by_numeric<Prompt>('updated_newest', 'updated (latest)', 'updated', 'desc'),
		// sort_by_numeric<Prompt>('updated_oldest', 'updated (past)', 'updated', 'asc'),
		sort_by_numeric<Prompt>('created_newest', 'created (newest)', 'created', 'desc'),
		sort_by_numeric<Prompt>('created_oldest', 'created (oldest)', 'created', 'asc'),
		sort_by_text<Prompt>('name_asc', 'name (a-z)', 'name'),
		sort_by_text<Prompt>('name_desc', 'name (z-a)', 'name', 'desc'),
	]}
	sort_key_default="updated_newest"
	no_items=""
>
	{#snippet children(prompt)}
		<div transition:slide>
			<PromptListitem {prompt} selected={prompt.id === selected_prompt_id} />
		</div>
	{/snippet}
</SortableList>

<script lang="ts">
	import Picker from './Picker.svelte';
	import ModelListitem from './ModelListitem.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import type {Model} from './model.svelte.js';
	import {sort_by_text} from './sortable.svelte.js';

	const app = frontend_context.get();
	const {models} = app;

	const {
		items = models.ordered_by_name,
		onpick,
		filter,
		heading = 'pick a model',
	}: {
		onpick: (model: Model | undefined) => boolean | void;
		items?: Array<Model>;
		filter?: ((model: Model) => boolean) | undefined;
		heading?: string | null;
	} = $props();
</script>

<Picker
	{items}
	{onpick}
	{filter}
	sorters={[
		sort_by_text<Model>('name_asc', 'name (a-z)', 'name'),
		sort_by_text<Model>('name_desc', 'name (z-a)', 'name', 'desc'),
		sort_by_text<Model>('provider_asc', 'provider (a-z)', 'provider_name'),
		sort_by_text<Model>('provider_desc', 'provider (z-a)', 'provider_name', 'desc'),
	]}
	sort_key_default="name_asc"
	show_sort_controls
	{heading}
>
	{#snippet children(model, pick)}
		<button type="button" class="listitem compact width:100%" onclick={() => pick(model)}>
			<ModelListitem {model} />
		</button>
	{/snippet}
</Picker>

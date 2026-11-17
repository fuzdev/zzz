<script lang="ts">
	import Picker from './Picker.svelte';
	import ModelListitem from './ModelListitem.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import { model_sorters, type Model } from './model.svelte.ts';

	const app = frontend_context.get();
	const { models } = app;

	const {
		items = models.ordered_by_name,
		onpick,
		filter,
		heading = 'pick a model'
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
	sorters={model_sorters}
	sort_key_default="name_asc"
	show_sort_controls
	{heading}
>
	{#snippet children(model, pick)}
		<button type="button" class="listitem sized_sm width:100%" onclick={() => pick(model)}>
			<ModelListitem {model} />
		</button>
	{/snippet}
</Picker>

<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import PickerDialog from './PickerDialog.svelte';
	import ModelListitem from './ModelListitem.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import type {Model} from './model.svelte.js';
	import {sort_by_text} from './sortable.svelte.js';

	const app = frontend_context.get();
	const {models} = app;

	let {
		show = $bindable(false),
		onpick,
		filter,
		dialog_props,
		children: children_prop,
	}: {
		show: boolean;
		onpick: (model: Model | undefined) => boolean | void;
		filter?: ((model: Model) => boolean) | undefined;
		dialog_props?: OmitStrict<ComponentProps<typeof Dialog>, 'children'> | undefined;
		children?: Snippet | undefined;
	} = $props();
</script>

<PickerDialog
	bind:show
	items={models.ordered_by_name}
	{onpick}
	{filter}
	{dialog_props}
	sorters={[
		sort_by_text<Model>('name_asc', 'name (a-z)', 'name'),
		sort_by_text<Model>('name_desc', 'name (z-a)', 'name', 'desc'),
		sort_by_text<Model>('provider_asc', 'provider (a-z)', 'provider_name'),
		sort_by_text<Model>('provider_desc', 'provider (z-a)', 'provider_name', 'desc'),
	]}
	sort_key_default="name_asc"
	show_sort_controls
	heading="Pick a model"
>
	{#snippet children(model, pick)}
		{#if children_prop}
			{@render children_prop()}
		{/if}
		<button type="button" class="listitem compact width:100%" onclick={() => pick(model)}>
			<ModelListitem {model} />
		</button>
	{/snippet}
</PickerDialog>

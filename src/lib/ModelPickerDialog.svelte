<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import PickerDialog from './PickerDialog.svelte';
	import ModelListitem from './ModelListitem.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import { model_sorters, type Model } from './model.svelte.ts';

	const app = frontend_context.get();
	const { models } = app;

	let {
		show = $bindable(false),
		onpick,
		filter,
		dialog_props,
		children: children_prop
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
	sorters={model_sorters}
	sort_key_default="name_asc"
	show_sort_controls
	heading="Pick a model"
>
	{#snippet children(model, pick)}
		{#if children_prop}
			{@render children_prop()}
		{/if}
		<button type="button" class="listitem sized_sm width:100%" onclick={() => pick(model)}>
			<ModelListitem {model} />
		</button>
	{/snippet}
</PickerDialog>

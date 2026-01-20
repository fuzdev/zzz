<script lang="ts">
	import type {ComponentProps} from 'svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import PickerDialog from './PickerDialog.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import type {Prompt} from './prompt.svelte.js';
	import PromptSummary from './PromptSummary.svelte';
	import type {Uuid} from './zod_helpers.js';
	import {sort_by_text, sort_by_numeric} from './sortable.svelte.js';

	let {
		show = $bindable(false),
		onpick,
		filter,
		exclude_ids,
		selected_ids,
		dialog_props,
	}: {
		onpick: (prompt: Prompt | undefined) => boolean | void;
		show?: boolean | undefined;
		filter?: ((prompt: Prompt) => boolean) | undefined;
		exclude_ids?: Array<Uuid> | undefined;
		selected_ids?: Array<Uuid> | undefined;
		dialog_props?: OmitStrict<ComponentProps<typeof Dialog>, 'children'> | undefined;
	} = $props();

	const app = frontend_context.get();
	const {prompts} = app;
</script>

<PickerDialog
	bind:show
	items={prompts.ordered_items}
	{onpick}
	{filter}
	{exclude_ids}
	{dialog_props}
	sorters={[
		// TODO @many rework API to avoid casting
		sort_by_text<Prompt>('name_asc', 'name (a-z)', 'name'),
		sort_by_text<Prompt>('name_desc', 'name (z-a)', 'name', 'desc'),
		sort_by_numeric('created_newest', 'newest first', 'created_date', 'desc'),
		sort_by_numeric('created_oldest', 'oldest first', 'created_date', 'asc'),
	]}
	sort_key_default="name_asc"
	show_sort_controls
	heading="Pick a prompt"
>
	{#snippet children(prompt, pick)}
		<button
			type="button"
			class="listitem compact width:100%"
			class:selected={selected_ids?.includes(prompt.id)}
			onclick={() => pick(prompt)}
		>
			<div class="p_xs font_size_sm">
				<PromptSummary {prompt} />
			</div>
		</button>
	{/snippet}
</PickerDialog>

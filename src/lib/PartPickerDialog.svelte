<script lang="ts">
	import type {ComponentProps} from 'svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import PickerDialog from './PickerDialog.svelte';
	import PartListitem from './PartListitem.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import type {PartUnion} from './part.svelte.js';
	import type {Uuid} from './zod_helpers.js';
	import {sort_by_text, sort_by_numeric} from './sortable.svelte.js';

	const app = frontend_context.get();
	const {parts} = app;

	let {
		show = $bindable(false),
		onpick,
		filter,
		exclude_ids,
		dialog_props,
	}: {
		onpick: (part: PartUnion | undefined) => boolean | void;
		show?: boolean | undefined;
		filter?: ((part: PartUnion) => boolean) | undefined;
		exclude_ids?: Array<Uuid> | undefined;
		dialog_props?: OmitStrict<ComponentProps<typeof Dialog>, 'children'> | undefined;
	} = $props();
</script>

<PickerDialog
	bind:show
	items={parts.items.values}
	{onpick}
	{filter}
	{exclude_ids}
	{dialog_props}
	sorters={[
		// TODO @many rework API to avoid casting
		sort_by_numeric('created_newest', 'newest first', 'created_date', 'desc'),
		sort_by_numeric('created_oldest', 'oldest first', 'created_date', 'asc'),
		sort_by_text<PartUnion>('type_asc', 'type (a-z)', 'type'),
		sort_by_text<PartUnion>('type_desc', 'type (z-a)', 'type', 'desc'),
		sort_by_text<PartUnion>('name_asc', 'name (a-z)', 'name'),
		sort_by_text<PartUnion>('name_desc', 'name (z-a)', 'name', 'desc'),
		sort_by_numeric<PartUnion>('token_count_highest', 'tokens (most)', 'token_count', 'desc'),
		sort_by_numeric<PartUnion>('token_count_lowest', 'tokens (least)', 'token_count', 'asc'),
	]}
	sort_key_default="created_newest"
	show_sort_controls
	heading="Pick a part"
>
	{#snippet children(part, pick)}
		<PartListitem {part} sm onclick={() => pick(part)} />
	{/snippet}
</PickerDialog>

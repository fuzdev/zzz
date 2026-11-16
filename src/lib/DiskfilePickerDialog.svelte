<script lang="ts" module>
	import type { Diskfile } from './diskfile.svelte.ts';
	import { sort_by_text, sort_by_numeric, type Sorter } from './sortable.svelte.ts';

	/**
	 * The picker's sort orders. The size orders go by the size on disk, so a
	 * file whose content isn't loaded sorts by its bytes too, and a file of
	 * unknown size goes last either way.
	 */
	export const diskfile_picker_sorters: Array<Sorter<Diskfile>> = [
		// TODO @many rework API to avoid casting
		sort_by_text<Diskfile>('path_asc', 'path (a-z)', 'path'),
		sort_by_text<Diskfile>('path_desc', 'path (z-a)', 'path', 'desc'),
		sort_by_numeric('created_newest', 'newest first', 'created_date', 'desc'),
		sort_by_numeric('created_oldest', 'oldest first', 'created_date', 'asc'),
		sort_by_numeric('updated_recently', 'recently updated', 'updated_date', 'desc'),
		sort_by_numeric('updated_oldest', 'least recently updated', 'updated_date', 'asc'),
		sort_by_numeric<Diskfile>('size_largest', 'largest first', 'size', 'desc'),
		sort_by_numeric<Diskfile>('size_smallest', 'smallest first', 'size', 'asc')
	];
</script>

<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import PickerDialog from './PickerDialog.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileListitem from './DiskfileListitem.svelte';

	let {
		show = $bindable(false),
		onpick,
		filter,
		exclude_ids,
		selected_ids,
		dialog_props
	}: {
		onpick: (diskfile: Diskfile | undefined) => boolean | void;
		show?: boolean | undefined;
		filter?: ((diskfile: Diskfile) => boolean) | undefined;
		exclude_ids?: Array<Uuid> | undefined;
		selected_ids?: Array<Uuid> | undefined;
		dialog_props?: OmitStrict<ComponentProps<typeof Dialog>, 'children'> | undefined;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;
</script>

<PickerDialog
	bind:show
	items={diskfiles.on_disk}
	{onpick}
	{filter}
	{exclude_ids}
	{dialog_props}
	sorters={diskfile_picker_sorters}
	sort_key_default="path_asc"
	show_sort_controls
	heading="Pick a file"
	search_text={(diskfile) => diskfile.path}
	search_placeholder="filter by path"
	windowed
>
	{#snippet children(diskfile, pick)}
		<DiskfileListitem
			{diskfile}
			selected={!!selected_ids && selected_ids.includes(diskfile.id)}
			onselect={pick}
		/>
	{/snippet}
</PickerDialog>

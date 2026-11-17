<script lang="ts" module>
	import type { DiskfilePath, SerializableDisknode } from './diskfile_types.ts';
	import { sort_by_text, type Sorter } from './sortable.svelte.ts';
	import { sort_index_records_by_numeric, type DiskfileIndex } from './diskfile_index.svelte.ts';

	/**
	 * Creates the picker's sort orders, over records from `index`. The size
	 * orders go by the size on disk, and the time orders by the times on disk;
	 * a file whose size or time is unknown goes last either way.
	 *
	 * @param index - the index the picked records come from, read live by the size and time orders
	 * @returns the sorters
	 */
	export const create_diskfile_picker_sorters = (
		index: DiskfileIndex
	): Array<Sorter<SerializableDisknode>> => [
		sort_by_text<SerializableDisknode>('path_asc', 'path (a-z)', 'id'),
		sort_by_text<SerializableDisknode>('path_desc', 'path (z-a)', 'id', 'desc'),
		sort_index_records_by_numeric(index, 'created_newest', 'newest first', 'ctime', 'desc'),
		sort_index_records_by_numeric(index, 'created_oldest', 'oldest first', 'ctime', 'asc'),
		sort_index_records_by_numeric(index, 'updated_recently', 'recently updated', 'mtime', 'desc'),
		sort_index_records_by_numeric(
			index,
			'updated_oldest',
			'least recently updated',
			'mtime',
			'asc'
		),
		sort_index_records_by_numeric(index, 'size_largest', 'largest first', 'size', 'desc'),
		sort_index_records_by_numeric(index, 'size_smallest', 'smallest first', 'size', 'asc')
	];
</script>

<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import PickerDialog from './PickerDialog.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileListitem from './DiskfileListitem.svelte';

	let {
		show = $bindable(false),
		onpick,
		filter,
		selected_paths,
		dialog_props
	}: {
		/** Called with the picked file's path, or `undefined` when the picker closes without one. */
		onpick: (path: DiskfilePath | undefined) => boolean | void;
		show?: boolean | undefined;
		filter?: ((record: SerializableDisknode) => boolean) | undefined;
		selected_paths?: Array<DiskfilePath> | undefined;
		dialog_props?: OmitStrict<ComponentProps<typeof Dialog>, 'children'> | undefined;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;

	const sorters = create_diskfile_picker_sorters(diskfiles.index);
</script>

<PickerDialog
	bind:show
	items={diskfiles.on_disk}
	onpick={(record) => onpick(record?.id)}
	{filter}
	{dialog_props}
	{sorters}
	sort_key_default="path_asc"
	show_sort_controls
	heading="Pick a file"
	search_text={(record) => record.id}
	search_placeholder="filter by path"
	windowed
>
	{#snippet children(record, pick)}
		<DiskfileListitem
			path={record.id}
			selected={!!selected_paths && selected_paths.includes(record.id)}
			onselect={() => pick(record)}
		/>
	{/snippet}
</PickerDialog>

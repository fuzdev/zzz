<script lang="ts">
	import type { Snippet } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import type { SerializableDisknode } from './diskfile_types.ts';
	import DiskfileListitem from './DiskfileListitem.svelte';
	import SortableList from './SortableList.svelte';
	import { sort_by_text, type Sorter } from './sortable.svelte.ts';
	import { to_relative_path } from './diskfile_helpers.ts';
	import { sort_index_records_by_numeric } from './diskfile_index.svelte.ts';

	const {
		show_sort_controls = false,
		no_items
	}: {
		show_sort_controls?: boolean | undefined;
		/** What shows when no file is listed — `SortableList`'s default when `undefined`. */
		no_items?: Snippet | string | undefined;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;

	const sorters: Array<Sorter<SerializableDisknode>> = $derived.by(() => {
		// read once here, not per comparison: a sort compares a big list's paths millions of times
		const { zzz_dir } = app;
		const to_shown_path = (record: SerializableDisknode): string =>
			zzz_dir ? to_relative_path(record.id, zzz_dir) : record.id;
		const { index } = diskfiles;
		return [
			sort_by_text<SerializableDisknode>('path_asc', 'path (a-z)', to_shown_path),
			sort_by_text<SerializableDisknode>('path_desc', 'path (z-a)', to_shown_path, 'desc'),
			sort_index_records_by_numeric(index, 'updated_newest', 'updated (latest)', 'mtime', 'desc'),
			sort_index_records_by_numeric(index, 'updated_oldest', 'updated (past)', 'mtime', 'asc'),
			sort_index_records_by_numeric(index, 'created_newest', 'created (newest)', 'ctime', 'desc'),
			sort_index_records_by_numeric(index, 'created_oldest', 'created (oldest)', 'ctime', 'asc')
		];
	});
</script>

<!-- windowed: only the rows near the viewport render, so a project of thousands of files stays cheap -->
<SortableList
	items={diskfiles.listed}
	windowed
	{show_sort_controls}
	{sorters}
	sort_key_default="path_asc"
	{no_items}
>
	<!-- TODO show the status of being open in any tab (what signifier?) -->
	<!-- TODO bug with `selected` -->
	{#snippet children(record)}
		<DiskfileListitem
			path={record.id}
			selected={diskfiles.selected_path === record.id}
			reveal_in_tree
			onselect={(path, open_not_preview) => {
				// TODO this needs to navigate to the path of the file (so should be a link, not this onselect callback)
				diskfiles.select(path, open_not_preview);
			}}
		/>
	{/snippet}
</SortableList>

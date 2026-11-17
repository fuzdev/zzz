<script lang="ts">
	import type { Snippet } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileListitem from './DiskfileListitem.svelte';
	import SortableList from './SortableList.svelte';
	import { sort_by_text, sort_by_numeric } from './sortable.svelte.ts';

	const {
		show_sort_controls = false,
		no_items
	}: {
		show_sort_controls?: boolean | undefined;
		/** What shows when no file is listed — `SortableList`'s default when `undefined`. */
		no_items?: Snippet | string | undefined;
	} = $props();

	const { diskfiles } = frontend_context.get();
</script>

<!-- windowed: only the rows near the viewport render, so a project of thousands of files stays cheap -->
<SortableList
	items={diskfiles.listed}
	windowed
	{show_sort_controls}
	sorters={[
		// TODO @many rework API to avoid casting
		sort_by_text<Diskfile>('path_asc', 'path (a-z)', 'path_relative'),
		sort_by_text<Diskfile>('path_desc', 'path (z-a)', 'path_relative', 'desc'),
		sort_by_numeric<Diskfile>('updated_newest', 'updated (latest)', 'updated', 'desc'),
		sort_by_numeric<Diskfile>('updated_oldest', 'updated (past)', 'updated', 'asc'),
		sort_by_numeric<Diskfile>('created_newest', 'created (newest)', 'created', 'desc'),
		sort_by_numeric<Diskfile>('created_oldest', 'created (oldest)', 'created', 'asc')
	]}
	sort_key_default="path_asc"
	{no_items}
>
	<!-- TODO show the status of being open in any tab (what signifier?) -->
	<!-- TODO bug with `selected` -->
	{#snippet children(diskfile)}
		{@const selected = diskfiles.selected_path === diskfile.path}
		<DiskfileListitem
			{diskfile}
			{selected}
			reveal_in_tree
			onselect={(diskfile, open_not_preview) => {
				// TODO this needs to navigate to the path of the file (so should be a link, not this onselect callback)
				diskfiles.select(diskfile.path, open_not_preview);
			}}
		/>
	{/snippet}
</SortableList>

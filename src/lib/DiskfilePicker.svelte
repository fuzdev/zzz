<script lang="ts">
	import type {Uuid} from '@fuzdev/fuz_util/id.js';

	import Picker from './Picker.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import type {Diskfile} from './diskfile.svelte.js';
	import {sort_by_text, sort_by_numeric} from './sortable.svelte.js';
	import DiskfileListitem from './DiskfileListitem.svelte';

	const {
		onpick,
		filter,
		exclude_ids,
		selected_ids,
	}: {
		onpick: (diskfile: Diskfile | undefined) => boolean | void;
		filter?: ((diskfile: Diskfile) => boolean) | undefined;
		exclude_ids?: Array<Uuid> | undefined;
		selected_ids?: Array<Uuid> | undefined;
	} = $props();

	const app = frontend_context.get();
	const {diskfiles} = app;
</script>

<Picker
	items={diskfiles.items.values}
	{onpick}
	{filter}
	{exclude_ids}
	sorters={[
		// TODO @many rework API to avoid casting
		sort_by_text<Diskfile>('path_asc', 'path (a-z)', 'path'),
		sort_by_text<Diskfile>('path_desc', 'path (z-a)', 'path', 'desc'),
		sort_by_numeric('created_newest', 'newest first', 'created_date', 'desc'),
		sort_by_numeric('created_oldest', 'oldest first', 'created_date', 'asc'),
		sort_by_numeric('updated_recently', 'recently updated', 'updated_date', 'desc'),
		sort_by_numeric('updated_oldest', 'least recently updated', 'updated_date', 'asc'),
		sort_by_numeric<Diskfile>('font_size_largest', 'largest first', 'content_length', 'desc'),
		sort_by_numeric<Diskfile>('font_size_smallest', 'smallest first', 'content_length', 'asc'),
	]}
	sort_key_default="path_asc"
	show_sort_controls
	heading="Pick a file"
>
	{#snippet children(diskfile, pick)}
		<DiskfileListitem
			{diskfile}
			selected={!!selected_ids && selected_ids.includes(diskfile.id)}
			onselect={pick}
		/>
	{/snippet}
</Picker>

<script lang="ts">
	import { slide } from 'svelte/transition';
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileListitem from './DiskfileListitem.svelte';
	import {
		icon_create_directory,
		icon_create_file,
		icon_sort,
		icon_workspace
	} from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import SortableList from './SortableList.svelte';
	import { sort_by_text, sort_by_numeric } from './sortable.svelte.ts';
	import { prompt_create_diskfile } from './diskfile_helpers.ts';

	const {
		empty
	}: {
		empty?: Snippet | undefined;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;
	const { editor } = diskfiles;

	const { zzz_dir } = $derived(app);
	const { new_files_dir } = $derived(diskfiles);

	// TODO need awaitable websocket calls?
	const TODO_create_file_pending = false;
	const TODO_create_folder_pending = false;
</script>

<div class="height:100% overflow:auto scrollbar-width:thin">
	{#if zzz_dir === undefined}
		<div>&nbsp;</div>
	{:else if zzz_dir === null && app.session_status === 'failure'}
		<div class="row height-input-height px_xs">
			<small class="ellipsis" title={app.session_error}>session failed to load, retrying</small>
		</div>
	{:else if zzz_dir === null}
		<div class="row height-input-height"><PendingAnimation /></div>
	{:else}
		<div class="row height-input-height justify-content:space-between px_xs">
			{#if new_files_dir}
				<small class="ellipsis" title="new files and folders go in the active workspace">
					<Icon data={icon_workspace} />
					{new_files_dir}
				</small>
			{:else}
				<small class="ellipsis">
					<a href={resolve('/workspaces')}>open a workspace</a> to create files
				</small>
			{/if}
			<div class="display:flex gap_xs2">
				<PendingButton
					pending={TODO_create_file_pending}
					class="plain sm"
					title={new_files_dir
						? `create file in ${new_files_dir}`
						: 'open a workspace to create files'}
					disabled={!new_files_dir}
					onclick={() => prompt_create_diskfile(diskfiles, 'file')}
				>
					<Icon data={icon_create_file} />
				</PendingButton>
				<PendingButton
					pending={TODO_create_folder_pending}
					class="plain sm"
					title={new_files_dir
						? `create folder in ${new_files_dir}`
						: 'open a workspace to create folders'}
					disabled={!new_files_dir}
					onclick={() => prompt_create_diskfile(diskfiles, 'folder')}
				>
					<Icon data={icon_create_directory} />
				</PendingButton>
				{#if diskfiles.listed.length > 1}
					<button
						type="button"
						class="plain sm selectable deselectable"
						class:selected={editor.show_sort_controls}
						title="toggle sort controls"
						onclick={() => editor.toggle_sort_controls()}
					>
						<Icon data={icon_sort} />
					</button>
				{/if}
			</div>
		</div>

		<!-- TODO @many improve efficiency - maybe add `all` back to the base IndexedCollection, or add an incremental index for this case? -->
		<SortableList
			items={diskfiles.listed}
			show_sort_controls={editor.show_sort_controls}
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
			no_items={empty ? undefined : '[no files available]'}
		>
			<!-- TODO show the status of being open in any tab (what signifier?) -->
			<!-- TODO bug with `selected` -->
			{#snippet children(diskfile)}
				{@const selected = diskfiles.selected_file_id === diskfile.id}
				<div class="diskfile-listitem-wrapper" class:selected transition:slide>
					<DiskfileListitem
						{diskfile}
						{selected}
						onselect={(diskfile, open_not_preview) => {
							// TODO this needs to navigate to the path of the file (so should be a link, not this onselect callback)
							diskfiles.select(diskfile.id, open_not_preview);
						}}
					/>
				</div>
			{/snippet}
		</SortableList>

		{#if empty && diskfiles.listed.length === 0}
			{@render empty()}
		{/if}
	{/if}
</div>

<style>
	.diskfile-listitem-wrapper {
		position: sticky;
		top: 0;
		bottom: 0;
		background-color: var(--shade_00);
	}
</style>

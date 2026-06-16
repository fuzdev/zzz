<script lang="ts">
	import {slide} from 'svelte/transition';
	import type {Snippet} from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import {frontend_context} from './frontend.svelte.ts';
	import type {Diskfile} from './diskfile.svelte.ts';
	import DiskfileListitem from './DiskfileListitem.svelte';
	import {
		icon_create_directory,
		icon_create_file,
		icon_directory,
		icon_sort,
	} from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import SortableList from './SortableList.svelte';
	import {sort_by_text, sort_by_numeric} from './sortable.svelte.ts';

	const {
		empty,
	}: {
		empty?: Snippet | undefined;
	} = $props();

	const app = frontend_context.get();
	const {diskfiles} = app;
	const {editor} = diskfiles;

	const {zzz_dir} = $derived(app);

	// TODO need awaitable websocket calls?
	const TODO_create_file_pending = false;
	const TODO_create_folder_pending = false;

	// TODO @many this is very hacky and duplicated, refactor into cell methods
	// TODO @many improve UX to not use alert/prompt
	const create_file = async () => {
		if (!zzz_dir) {
			alert('cannot create file: filesystem is not available'); // eslint-disable-line no-alert
			return;
		}

		const filename = prompt('new file name:'); // eslint-disable-line no-alert
		if (!filename) return;

		try {
			await diskfiles.create_file(filename);
		} catch (error) {
			console.error('failed to create file:', error);
			alert(`failed to create file: ${error}`); // eslint-disable-line no-alert
		}
	};

	const create_folder = async () => {
		if (!zzz_dir) {
			alert('cannot create folder: filesystem is not available'); // eslint-disable-line no-alert
			return;
		}

		const dirname = prompt('New folder name:'); // eslint-disable-line no-alert
		if (!dirname) return;

		try {
			await diskfiles.create_directory(dirname);
		} catch (error) {
			console.error('failed to create folder:', error);
			alert(`failed to create folder: ${error}`); // eslint-disable-line no-alert
		}
	};
</script>

<div class="height:100% overflow:auto scrollbar-width:thin">
	{#if zzz_dir === undefined}
		<div>&nbsp;</div>
	{:else if zzz_dir === null}
		<div class="row height-input-height"><PendingAnimation /></div>
	{:else}
		<div class="row height-input-height justify-content:space-between px_xs">
			<small class="ellipsis"><Svg data={icon_directory} /> {zzz_dir}</small>
			<div class="display:flex gap_xs2">
				<PendingButton
					pending={TODO_create_file_pending}
					class="plain sm"
					title="create file in {zzz_dir}"
					onclick={create_file}
				>
					<Svg data={icon_create_file} />
				</PendingButton>
				<PendingButton
					pending={TODO_create_folder_pending}
					class="plain sm"
					title="create folder in {zzz_dir}"
					onclick={create_folder}
				>
					<Svg data={icon_create_directory} />
				</PendingButton>
				{#if app.diskfiles.items.size > 1}
					<button
						type="button"
						class="plain sm selectable deselectable"
						class:selected={editor.show_sort_controls}
						title="toggle sort controls"
						onclick={() => editor.toggle_sort_controls()}
					>
						<Svg data={icon_sort} />
					</button>
				{/if}
			</div>
		</div>

		<!-- TODO @many improve efficiency - maybe add `all` back to the base IndexedCollection, or add an incremental index for this case? -->
		<SortableList
			items={diskfiles.items.values}
			show_sort_controls={editor.show_sort_controls}
			sorters={[
				// TODO @many rework API to avoid casting
				sort_by_text<Diskfile>('path_asc', 'path (a-z)', 'path_relative'),
				sort_by_text<Diskfile>('path_desc', 'path (z-a)', 'path_relative', 'desc'),
				sort_by_numeric<Diskfile>('updated_newest', 'updated (latest)', 'updated', 'desc'),
				sort_by_numeric<Diskfile>('updated_oldest', 'updated (past)', 'updated', 'asc'),
				sort_by_numeric<Diskfile>('created_newest', 'created (newest)', 'created', 'desc'),
				sort_by_numeric<Diskfile>('created_oldest', 'created (oldest)', 'created', 'asc'),
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

		{#if empty && diskfiles.items.size === 0}
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

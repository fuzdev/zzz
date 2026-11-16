<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileList from './DiskfileList.svelte';
	import {
		icon_create_directory,
		icon_create_file,
		icon_sort,
		icon_workspace
	} from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { prompt_create_diskfile } from './diskfile_helpers.ts';
	import { icon_microphone } from './media_icons.ts';

	const {
		empty
	}: {
		empty?: Snippet | undefined;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles, recorder } = app;
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
			<div class="flex gap_xs2">
				<PendingButton
					pending={TODO_create_file_pending}
					class="plain sized_sm"
					title={new_files_dir
						? `create file in ${new_files_dir}`
						: 'open a workspace to create files'}
					disabled={!new_files_dir}
					onclick={() => prompt_create_diskfile(diskfiles, 'file')}
				>
					<Icon data={icon_create_file} />
				</PendingButton>
				<PendingButton
					pending={recorder.status === 'starting'}
					class="plain sized_sm"
					title={!new_files_dir
						? 'open a workspace to record'
						: recorder.active
							? 'a recording is under way'
							: `record audio to a new file in ${new_files_dir}`}
					disabled={!new_files_dir || recorder.active}
					onclick={() => {
						// in the click itself: the microphone opens only on a user gesture —
						// a failure shows in the recorder indicator
						if (new_files_dir) recorder.start(new_files_dir).catch(() => undefined);
					}}
				>
					<Icon data={icon_microphone} />
				</PendingButton>
				<PendingButton
					pending={TODO_create_folder_pending}
					class="plain sized_sm"
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
						class="plain sized_sm selectable deselectable"
						class:selected={editor.show_sort_controls}
						title="toggle sort controls"
						onclick={() => editor.toggle_sort_controls()}
					>
						<Icon data={icon_sort} />
					</button>
				{/if}
			</div>
		</div>

		<DiskfileList
			show_sort_controls={editor.show_sort_controls}
			no_items={empty ? undefined : '[no files available]'}
		/>

		{#if empty && diskfiles.listed.length === 0}
			{@render empty()}
		{/if}
	{/if}
</div>

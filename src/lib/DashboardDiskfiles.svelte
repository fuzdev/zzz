<script lang="ts">
	import { resolve } from '$app/paths';
	import { swallow, is_editable } from '@fuzdev/fuz_util/dom.ts';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';
	import { random_item } from '@fuzdev/fuz_util/random.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import { onMount } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileExplorer from './DiskfileExplorer.svelte';
	import DiskfileView from './DiskfileView.svelte';
	import DiskfileTabListitem from './DiskfileTabListitem.svelte';
	import { Reorderable } from './reorderable.svelte.ts';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import { prompt_create_diskfile } from './diskfile_helpers.ts';

	const app = frontend_context.get();
	const { diskfiles, capabilities } = app;
	const { editor } = diskfiles;

	const tabs_reorderable = new Reorderable({ item_class: null }); // remove the normal reorderable item styling

	const selected_tab = $derived(editor.tabs.selected_tab);
	const selected_diskfile = $derived(
		selected_tab ? diskfiles.items.by_id.get(selected_tab.diskfile_id) : undefined
	);

	let show_diskfile_picker = $state.raw(false);

	onMount(() => {
		void capabilities.init_backend_check();
	});

	/**
	 * Closes a tab — or asks first, for a file with a draft, and the close
	 * dialog handles focus — then focuses the newly selected tab's editor, since
	 * the removed tab (and its close button) would otherwise drop focus to `body`.
	 */
	const close_tab = (tab_id: Uuid): void => {
		editor.request_close_tab(tab_id);
		if (editor.tabs.items.by_id.has(tab_id)) return; // asking first
		const diskfile_id = editor.tabs.selected_diskfile_id;
		if (diskfile_id) app.ui.pending_element_to_focus_key = diskfile_id;
	};
</script>

<svelte:window
	onkeydown={(e) => {
		if (is_editable(e.target)) {
			return;
		}

		// ctrl+q: close tab
		if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'q') {
			swallow(e);
			const selected_tab = editor.tabs.selected_tab;
			if (selected_tab) {
				close_tab(selected_tab.id);
			}
		}

		// ctrl+shift+Q: reopen last closed tab
		if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
			swallow(e);
			editor.reopen_last_closed_tab();
		}
	}}
/>

<div class="height:100% display:flex">
	{#if capabilities.filesystem_available === false}
		<div class="box height:100% width:100%">
			<div class="width_atmost_sm">
				<ErrorMessage>
					<p>
						Filesystem is not available. File management requires a backend connection with
						filesystem access.
					</p>
					<p class="mt_md">
						<button
							type="button"
							disabled={capabilities.backend.status === 'pending'}
							onclick={() => capabilities.check_backend()}
						>
							retry connection
						</button>
					</p>
				</ErrorMessage>
			</div>
		</div>
	{:else if capabilities.filesystem_available === null ||
		capabilities.filesystem_available === undefined
	}
		<div class="box height:100% width:100% display:flex align-items:center justify-content:center">
			<div class="text-align:center">
				<p class="mt_md">loading filesystem <PendingAnimation inline /></p>
			</div>
		</div>
	{:else}
		<div class="height:100% overflow:hidden width_atmost_sm">
			<DiskfileExplorer />
		</div>

		<div class="flex:1 column overflow:auto height:100%">
			<!-- tabs -->
			<menu
				class="unstyled display:flex overflow-x:auto scrollbar-width:thin"
				{@attach tabs_reorderable.list({
					onreorder: (from_index, to_index) => editor.reorder_tabs(from_index, to_index)
				})}
			>
				{#each editor.tabs.ordered_tabs as tab, index (tab.id)}
					<li class="display:flex py_xs3 px_xs4">
						<div class="display:flex" {@attach tabs_reorderable.item({ index })}>
							<!-- TODO notice the different APIs here, needs fixing, diskfiles is higher in the tree -->
							<DiskfileTabListitem
								{tab}
								onselect={(tab) => diskfiles.select(tab.diskfile_id)}
								onclose={(tab) => close_tab(tab.id)}
								onopen={(tab) => editor.open_tab(tab.id)}
							/>
						</div>
					</li>
				{/each}
			</menu>

			<!-- editor content area -->
			{#if selected_tab}
				{#if selected_diskfile}
					<DiskfileView
						diskfile={selected_diskfile}
						onmodified={(diskfile_id) => editor.handle_file_modified(diskfile_id)}
					/>
				{:else}
					<!-- TODO think this through - maybe the tabs should be more flexible than 1:1 with a diskfile? maybe `DiskfileView` should have UI to create a file if there is none? -->
					<div class="box height:100%">
						<p>Something went wrong, this tab has no diskfile</p>
					</div>
				{/if}
			{:else if diskfiles.on_disk.length > 0}
				<div class="box height:100%">
					<p>
						<button
							type="button"
							class="inline"
							onclick={() => {
								show_diskfile_picker = true;
							}}
						>
							select
						</button>
						a file from the list or
						<button
							type="button"
							class="inline palette_f"
							onclick={() => {
								const diskfile = random_item(app.diskfiles.on_disk);
								diskfiles.select(diskfile.id);
							}}
						>
							go fish
						</button> to view and edit its content
					</p>
				</div>
			{:else}
				<div class="box height:100%">
					<p>
						no files yet,
						{#if diskfiles.new_files_dir}
							<button
								type="button"
								class="inline palette_d"
								onclick={() => prompt_create_diskfile(diskfiles, 'file')}
							>
								create a new file
							</button>?
						{:else}
							<a href={resolve('/workspaces')}>open a workspace</a> to create one
						{/if}
					</p>
				</div>
			{/if}
		</div>
	{/if}
</div>

<DiskfilePickerDialog
	bind:show={show_diskfile_picker}
	onpick={(diskfile) => {
		if (!diskfile) return false;
		diskfiles.select(diskfile.id);
		return true;
	}}
/>

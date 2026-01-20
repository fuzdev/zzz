<script lang="ts">
	import {swallow, is_editable} from '@fuzdev/fuz_util/dom.js';
	import {random_item} from '@fuzdev/fuz_util/random.js';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {onMount} from 'svelte';

	import {frontend_context} from './frontend.svelte.js';
	import DiskfileExplorer from './DiskfileExplorer.svelte';
	import DiskfileEditorView from './DiskfileEditorView.svelte';
	import DiskfileTabListitem from './DiskfileTabListitem.svelte';
	import {Reorderable} from './reorderable.svelte.js';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import ErrorMessage from './ErrorMessage.svelte';

	const app = frontend_context.get();
	const {diskfiles, capabilities} = app;
	const {editor} = diskfiles;

	const tabs_reorderable = new Reorderable({item_class: null}); // remove the normal reorderable item styling

	const selected_tab = $derived(editor.tabs.selected_tab);
	const selected_diskfile = $derived(
		selected_tab ? diskfiles.items.by_id.get(selected_tab.diskfile_id) : undefined,
	);

	let show_diskfile_picker = $state(false);

	onMount(() => {
		void capabilities.init_backend_check();
	});

	// TODO @many this is very hacky and duplicated, refactor into cell methods
	// TODO @many improve UX to not use alert/prompt
	const create_file = async () => {
		if (!app.zzz_dir) {
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
				editor.close_tab(selected_tab.id);
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
	{:else if capabilities.filesystem_available === null || capabilities.filesystem_available === undefined}
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
					onreorder: (from_index, to_index) => editor.reorder_tabs(from_index, to_index),
				})}
			>
				{#each editor.tabs.ordered_tabs as tab, index (tab.id)}
					<li class="display:flex py_xs3 px_xs4">
						<div class="display:flex" {@attach tabs_reorderable.item({index})}>
							<!-- TODO notice the different APIs here, needs fixing, diskfiles is higher in the tree -->
							<DiskfileTabListitem
								{tab}
								onselect={(tab) => diskfiles.select(tab.diskfile_id)}
								onclose={(tab) => {
									// TODO does this logic belong in a `diskfiles` method that wraps editor.close_tab?
									if (tab.diskfile_id === selected_diskfile?.id) {
										diskfiles.select(null);
									}
									editor.close_tab(tab.id);
								}}
								onopen={(tab) => editor.open_tab(tab.id)}
							/>
						</div>
					</li>
				{/each}
			</menu>

			<!-- editor content area -->
			{#if selected_tab}
				{#if selected_diskfile}
					<DiskfileEditorView
						diskfile={selected_diskfile}
						onmodified={(diskfile_id) => editor.handle_file_modified(diskfile_id)}
					/>
				{:else}
					<!-- TODO think this through - maybe the tabs should be more flexible than 1:1 with a diskfile? maybe `DiskfileEditorView` should have UI to create a file if there is none? -->
					<div class="box height:100%">
						<p>Something went wrong, this tab has no diskfile</p>
					</div>
				{/if}
			{:else if diskfiles.items.size > 0}
				<div class="box height:100%">
					<p>
						<button
							type="button"
							class="inline"
							onclick={() => {
								show_diskfile_picker = true;
							}}>select</button
						>
						a file from the list or
						<button
							type="button"
							class="inline color_f"
							onclick={() => {
								const diskfile = random_item(app.diskfiles.items.values);
								diskfiles.select(diskfile.id);
							}}>go fish</button
						> to view and edit its content
					</p>
				</div>
			{:else}
				<div class="box height:100%">
					<p>
						no files yet, <button type="button" class="inline color_d" onclick={create_file}
							>create a new file</button
						>?
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

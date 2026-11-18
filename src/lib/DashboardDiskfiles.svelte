<script lang="ts">
	import { resolve } from '$app/paths';
	import { swallow, is_editable } from '@fuzdev/fuz_util/dom.ts';
	import { random_item } from '@fuzdev/fuz_util/random.ts';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {
		icon_desk,
		icon_double_chevron_left,
		icon_double_chevron_right
	} from '@fuzdev/fuz_ui/icons.ts';
	import { onMount } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileExplorer from './DiskfileExplorer.svelte';
	import DiskfileView from './DiskfileView.svelte';
	import { DISKFILE_DETAILS_DRAWER_ID } from './DiskfileDetailsDrawer.svelte';
	import Icon from './Icon.svelte';
	import DiskfileTabListitem from './DiskfileTabListitem.svelte';
	import { Reorderable } from './reorderable.svelte.ts';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import { prompt_create_diskfile } from './diskfile_helpers.ts';
	import type { DiskfilePath } from './diskfile_types.ts';
	import { to_keyed_move } from './list_helpers.ts';

	const app = frontend_context.get();
	const { diskfiles, capabilities } = app;
	const { editor } = diskfiles;

	const tabs_reorderable = new Reorderable({ item_class: null }); // remove the normal reorderable item styling

	const selected_tab = $derived(editor.tabs.selected_tab);
	const selected_diskfile = $derived(selected_tab ? diskfiles.peek(selected_tab.path) : undefined);

	let show_diskfile_picker = $state.raw(false);

	const details_title = $derived(
		app.ui.show_diskfile_details ? 'hide the file details' : 'show the file details'
	);

	onMount(() => {
		void capabilities.init_backend_check();
	});

	/**
	 * Closes a tab — or asks first, for a file with a draft, and the close
	 * dialog handles focus — then focuses the newly selected tab's editor, since
	 * the removed tab (and its close button) would otherwise drop focus to `body`.
	 */
	const close_tab = (path: DiskfilePath): void => {
		if (app.intents.tab_close({ path }).result !== 'closed') return; // asking first, or gone
		const selected = editor.tabs.selected_path;
		if (selected) app.ui.pending_element_to_focus_key = selected;
	};

	/**
	 * Moves the tab dragged from `from_index` to `to_index`, as the
	 * `tab_move` intent wants it: by path, in front of the tab that follows it
	 * there (or to the end).
	 */
	const move_tab = (from_index: number, to_index: number): void => {
		const move = to_keyed_move(
			editor.tabs.ordered_tabs.map((tab) => tab.path),
			from_index,
			to_index
		);
		if (move) app.intents.tab_move({ path: move.key, before_path: move.before });
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
				close_tab(selected_tab.path);
			}
		}

		// ctrl+shift+Q: reopen last closed tab
		if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
			swallow(e);
			app.intents.tab_reopen_closed();
		}
	}}
/>

<div class="height:100% flex">
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
		<div class="box height:100% width:100% flex align-items:center justify-content:center">
			<div class="text-align:center">
				<p class="mt_md">loading filesystem <PendingAnimation inline /></p>
			</div>
		</div>
	{:else}
		<div class="height:100% overflow:hidden width_atmost_sm">
			<DiskfileExplorer />
		</div>

		<div class="flex:1 column overflow:hidden height:100%">
			<!-- the header: the tabs, scrolling and shrinking first, then the details toggle - it and the
			desk button's placeholder sit at the top, in line with the desk button, not stretched to the
			tabs' height -->
			<div class="flex">
				<menu
					class="unstyled flex flex:1 min-width:0 overflow-x:auto scrollbar-width:thin"
					{@attach tabs_reorderable.list({
						onreorder: move_tab
					})}
				>
					{#each editor.tabs.ordered_tabs as tab, index (tab.id)}
						<li class="flex py_xs3 px_xs4">
							<div class="flex" {@attach tabs_reorderable.item({ index })}>
								<!-- TODO notice the different APIs here, needs fixing, diskfiles is higher in the tree -->
								<DiskfileTabListitem
									{tab}
									onselect={(tab) => app.intents.tab_select({ path: tab.path })}
									onclose={(tab) => close_tab(tab.path)}
									onopen={(tab) => app.intents.tab_pin({ path: tab.path })}
								/>
							</div>
						</li>
					{/each}
				</menu>
				{#if selected_diskfile}
					<button
						type="button"
						class="icon-button plain border-radius:0 align-self:flex-start"
						aria-label={details_title}
						title={details_title}
						aria-expanded={app.ui.show_diskfile_details}
						aria-controls={DISKFILE_DETAILS_DRAWER_ID}
						onclick={() => app.intents.diskfile_details_toggle()}
					>
						<Icon
							data={app.ui.show_diskfile_details
								? icon_double_chevron_right
								: icon_double_chevron_left}
						/>
					</button>
				{/if}
				{#if !app.ui.show_desk_menu && editor.tabs.ordered_tabs.length > 0}
					<!-- the desk menu button's footprint: it's fixed over the header's right end, so a copy
					with its classes and icon, never seen or reached, keeps the header's own controls out
					from under it (`Dashboard`) -->
					<button
						type="button"
						class="icon-button plain border-radius:0 border_bottom_left_radius_md visibility:hidden align-self:flex-start"
						disabled
						tabindex="-1"
						aria-hidden="true"
					>
						<Icon data={icon_desk} />
					</button>
				{/if}
			</div>

			<!-- editor content area: the space under the tabs, so a view's `height:100%` fits it and
			     the column never overflows - else `scrollIntoView` and focus scroll the tabs away -->
			<div class="flex:1 min-height:0">
				{#if selected_tab}
					{#if selected_diskfile}
						<DiskfileView
							diskfile={selected_diskfile}
							onmodified={(path) => editor.handle_file_modified(path)}
						/>
					{:else}
						<!-- TODO think this through - maybe the tabs should be more flexible than 1:1 with a diskfile? maybe `DiskfileView` should have UI to create a file if there is none? -->
						<div class="box height:100%">
							<p>Something went wrong, this tab has no diskfile</p>
						</div>
					{/if}
				{:else if diskfiles.index.size > 0}
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
									const record = random_item(app.diskfiles.on_disk);
									app.intents.tab_open({ path: record.id });
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
								<a href={resolve('/projects')}>open a project</a> to create one
							{/if}
						</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<DiskfilePickerDialog
	bind:show={show_diskfile_picker}
	onpick={(path) => {
		if (!path) return false;
		app.intents.tab_open({ path });
		return true;
	}}
/>

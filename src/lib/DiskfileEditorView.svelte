<script lang="ts">
	import { slide } from 'svelte/transition';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileInfo from './DiskfileInfo.svelte';
	import type { Diskfile } from './diskfile.svelte.ts';
	import type { DiskfilePath } from './diskfile_types.ts';
	import ContentEditor from './ContentEditor.svelte';
	import DiskfileActions from './DiskfileActions.svelte';
	import DiskfileDetailsDrawer from './DiskfileDetailsDrawer.svelte';
	import DiskfileHistoryView from './DiskfileHistoryView.svelte';
	import { format_placeholder } from './helpers.ts';
	import DiskfilePartView from './DiskfilePartView.svelte';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import DiskfileEditorNav from './DiskfileEditorNav.svelte';
	import DiskfileDormantNotice from './DiskfileDormantNotice.svelte';
	import DiskfileConflictNotice, { save_from_view } from './DiskfileConflictNotice.svelte';
	import DiskfileSaveErrorNotice from './DiskfileSaveErrorNotice.svelte';
	import TutorialForDiskfiles from './TutorialForDiskfiles.svelte';
	import DiskfileLoadingNotice from './DiskfileLoadingNotice.svelte';
	import { DISKFILE_UNCOVERED_LABEL, to_diskfile_unloaded_message } from './diskfile_helpers.ts';

	const {
		diskfile,
		onmodified
	}: {
		diskfile: Diskfile;
		onmodified?: (path: DiskfilePath) => void;
	} = $props();

	const app = frontend_context.get();

	// app-level, so switching tabs or remounting keeps the draft, selection, and save state
	const editor_state = $derived(app.diskfiles.get_editor_state(diskfile));

	// loads the content on view — the editing state then keeps it current
	$effect(() => {
		void app.diskfiles.ensure_content(editor_state.diskfile);
	});

	// Reference to the content editor component
	let content_editor: { focus: () => void } | undefined = $state.raw();
	let conflict_notice: { focus: () => boolean } | undefined = $state.raw();

	// a blocked save points at the conflict notice rather than doing nothing silently
	const save = (): Promise<void> => save_from_view(editor_state, () => conflict_notice);

	// TODO refactor, try to remove
	$effect(() => {
		if (editor_state.content_was_modified_by_user) {
			onmodified?.(diskfile.path);
		}
	});
</script>

<DiskfileContextmenu path={diskfile.path}>
	<!-- a stacking context, so the details drawer's z-index (over the editor it slides across) stays
	inside the view, under the desk menu's overlay -->
	<div class="flex height:100% isolation:isolate">
		<div class="flex:1 width_atleast_sm height:100% column">
			{#if editor_state.content_loading}
				<DiskfileLoadingNotice
					suffix="read-only until it arrives"
					attrs={{ class: 'px_md py_xs' }}
				/>
			{:else if !editor_state.content_loaded}
				<p class="px_md py_xs color_c_60">
					{to_diskfile_unloaded_message(diskfile)} — read-only, it can't be edited or saved
				</p>
			{:else if editor_state.dormant}
				<DiskfileDormantNotice {diskfile} />
			{:else if diskfile.deleted_on_disk}
				<p class="px_md py_xs color_c_60">
					{#if editor_state.has_unsaved_edits}
						deleted on disk — save to recreate it with your edits, or
						<button
							type="button"
							class="inline sized_sm"
							title="discard the unsaved edits and forget the file once its tab closes"
							onclick={() => editor_state.discard_draft()}
						>
							discard them
						</button>
					{:else}
						deleted on disk — save to recreate it, or close the tab
					{/if}
				</p>
			{:else if diskfile.uncovered}
				<p class="px_md py_xs text_50">
					{DISKFILE_UNCOVERED_LABEL} — saving checks it hasn't changed on disk
				</p>
			{/if}
			<DiskfileConflictNotice
				bind:this={conflict_notice}
				{editor_state}
				onresolve={() => content_editor?.focus()}
				attrs={{ class: 'px_md py_xs' }}
			/>
			<DiskfileSaveErrorNotice {editor_state} attrs={{ class: 'px_md py_xs' }} />
			<ContentEditor
				bind:this={content_editor}
				bind:content={
					() => editor_state.shown_content,
					(content) => (editor_state.current_content = content)
				}
				focus_key={diskfile.path}
				bind:pending_element_to_focus_key={app.ui.pending_element_to_focus_key}
				token_count={editor_state.current_token_count}
				placeholder={editor_state.content_loaded
					? format_placeholder(diskfile.path_relative)
					: editor_state.content_loading
						? ''
						: '[content not loaded]'}
				readonly={!editor_state.can_edit}
				attrs={{ class: 'height:100% border-radius:0' }}
				save_shortcut="page"
				onsave={save}
			/>
		</div>

		<DiskfileDetailsDrawer>
			<div class="px_md mb_lg">
				<!-- delete can be the row's first button, and the drawer clips at its left edge -->
				<DiskfileActions
					{diskfile}
					{editor_state}
					readonly={!editor_state.content_loaded}
					delete_position="right"
				/>
			</div>

			<div class="px_md mb_lg">
				<DiskfileEditorNav {editor_state} />
			</div>

			<div class="px_md mb_lg">
				<DiskfileInfo {diskfile} {editor_state} />
			</div>

			{#if editor_state.has_history}
				<div transition:slide>
					<DiskfileHistoryView
						{editor_state}
						onselectentry={(entry_id) => {
							editor_state.set_content_from_history(entry_id);
							content_editor?.focus();
						}}
					/>
				</div>
			{/if}

			<DiskfilePartView {diskfile} />

			<div class="px_md">
				<TutorialForDiskfiles />
			</div>
		</DiskfileDetailsDrawer>
	</div>
</DiskfileContextmenu>

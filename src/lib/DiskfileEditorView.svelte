<script lang="ts">
	import { slide } from 'svelte/transition';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileInfo from './DiskfileInfo.svelte';
	import type { Diskfile } from './diskfile.svelte.ts';
	import ContentEditor from './ContentEditor.svelte';
	import DiskfileActions from './DiskfileActions.svelte';
	import DiskfileHistoryView from './DiskfileHistoryView.svelte';
	import { format_placeholder } from './helpers.ts';
	import DiskfilePartView from './DiskfilePartView.svelte';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import DiskfileEditorNav from './DiskfileEditorNav.svelte';
	import DiskfileConflictNotice from './DiskfileConflictNotice.svelte';
	import TutorialForDiskfiles from './TutorialForDiskfiles.svelte';
	import { DISKFILE_CONTENT_NOT_LOADED_MESSAGE } from './diskfile_helpers.ts';

	const {
		diskfile,
		onmodified
	}: {
		diskfile: Diskfile;
		onmodified?: (diskfile_id: Uuid) => void;
	} = $props();

	const app = frontend_context.get();

	// app-level, so switching tabs or remounting keeps the draft, selection, and save state
	const editor_state = $derived(app.diskfiles.get_editor_state(diskfile));

	// Reference to the content editor component
	let content_editor: { focus: () => void } | undefined = $state.raw();
	let conflict_notice: { focus: () => boolean } | undefined = $state.raw();

	const save = async (): Promise<void> => {
		// a blocked save points at the conflict notice rather than doing nothing silently
		if (editor_state.has_conflict && conflict_notice?.focus()) return;
		await editor_state.save_changes();
	};

	// TODO refactor, try to remove
	$effect(() => {
		if (editor_state.content_was_modified_by_user) {
			onmodified?.(diskfile.id);
		}
	});
</script>

<DiskfileContextmenu {diskfile}>
	<div class="display:flex height:100%">
		<div class="flex:1 width_atleast_sm height:100% column">
			{#if !editor_state.content_loaded}
				<p class="px_md py_xs mb_0 color_c_50">
					{DISKFILE_CONTENT_NOT_LOADED_MESSAGE} — read-only, it can't be edited or saved
				</p>
			{:else if diskfile.deleted_on_disk}
				<p class="px_md py_xs mb_0 color_c_50">
					{#if editor_state.has_unsaved_edits}
						deleted on disk — save to recreate it with your edits, or
						<button
							type="button"
							class="inline sm"
							title="discard the unsaved edits and forget the file once its tab closes"
							onclick={() => editor_state.discard_draft()}
						>
							discard them
						</button>
					{:else}
						deleted on disk — save to recreate it, or close the tab
					{/if}
				</p>
			{/if}
			<DiskfileConflictNotice
				bind:this={conflict_notice}
				{editor_state}
				onresolve={() => content_editor?.focus()}
				attrs={{ class: 'px_md py_xs' }}
			/>
			<ContentEditor
				bind:this={content_editor}
				bind:content={editor_state.current_content}
				focus_key={diskfile.id}
				bind:pending_element_to_focus_key={app.ui.pending_element_to_focus_key}
				token_count={editor_state.current_token_count}
				placeholder={editor_state.content_loaded
					? format_placeholder(diskfile.path_relative)
					: '[content not loaded]'}
				readonly={!editor_state.content_loaded}
				attrs={{ class: 'height:100% border-radius:0' }}
				save_shortcut="page"
				onsave={save}
			/>
		</div>

		<div class="width_atmost_sm width_atleast_sm py_md">
			<div class="px_md mb_lg">
				<DiskfileActions {diskfile} {editor_state} readonly={!editor_state.content_loaded} />
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
		</div>
	</div>
</DiskfileContextmenu>

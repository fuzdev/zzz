<script lang="ts">
	import { slide } from 'svelte/transition';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';
	import {
		icon_double_chevron_left,
		icon_double_chevron_right,
		icon_edit,
		icon_preview,
		icon_view
	} from '@fuzdev/fuz_ui/icons.ts';
	import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileInfo from './DiskfileInfo.svelte';
	import type { Diskfile } from './diskfile.svelte.ts';
	import SourceEditor from './SourceEditor.svelte';
	import MarkdownPreview from './MarkdownPreview.svelte';
	import DiskfileActions from './DiskfileActions.svelte';
	import DiskfileHistoryView from './DiskfileHistoryView.svelte';
	import { format_placeholder } from './helpers.ts';
	import DiskfilePartView from './DiskfilePartView.svelte';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import DiskfileEditorNav from './DiskfileEditorNav.svelte';
	import DiskfileConflictNotice from './DiskfileConflictNotice.svelte';
	import TutorialForDiskfiles from './TutorialForDiskfiles.svelte';
	import Icon from './Icon.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import { DISKFILE_CONTENT_NOT_LOADED_MESSAGE } from './diskfile_helpers.ts';
	import { lang_for_path } from './path_lang.ts';
	import { handle_save_shortcut_keydown } from './save_shortcut.ts';
	import {
		MARKDOWN_VIEW_MODES,
		MARKDOWN_VIEW_MODE_LABELS,
		type MarkdownViewMode
	} from './markdown_view_mode.ts';

	/*

	A markdown file: its source beside a live preview, either alone (`MarkdownViewMode`), over the
	same app-level editing state as `DiskfileEditorView` — drafts, conflicts, history, and save behave
	the same. The editor view's sidebar is a drawer here, since three columns is too many.

	*/

	const {
		diskfile,
		onmodified
	}: {
		diskfile: Diskfile;
		onmodified?: (diskfile_id: Uuid) => void;
	} = $props();

	const app = frontend_context.get();

	// app-level, so switching tabs or remounting keeps the draft, selection, save state, and mode
	const editor_state = $derived(app.diskfiles.get_editor_state(diskfile));

	const mode = $derived(editor_state.markdown_view_mode);
	const lang = $derived(lang_for_path(diskfile.path) ?? 'md');

	const MODE_ICONS: Record<MarkdownViewMode, SvgData> = {
		split: icon_view,
		preview: icon_preview,
		source: icon_edit
	};

	// TODO maybe remember this app-wide, it's a layout preference rather than a per-file one
	let drawer_open = $state(false);

	let source_editor: { focus: () => void } | undefined = $state.raw();
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

<!-- with no editor mounted, the page still saves on Ctrl+S, as the editor would -->
<svelte:document
	onkeydown={mode === 'preview' ? (event) => handle_save_shortcut_keydown(event, save) : undefined}
/>

<DiskfileContextmenu {diskfile}>
	<div class="display:flex height:100%">
		<div class="flex:1 width_atleast_sm height:100% column">
			<div class="row gap_xs px_md py_xs">
				{#each MARKDOWN_VIEW_MODES as m (m)}
					<button
						type="button"
						class="plain sized_sm selectable"
						class:selected={m === mode}
						aria-pressed={m === mode}
						onclick={() => {
							editor_state.markdown_view_mode_choice = m;
						}}
					>
						<Icon data={MODE_ICONS[m]} /> <span class="ml_xs">{MARKDOWN_VIEW_MODE_LABELS[m]}</span>
					</button>
				{/each}
				<div class="flex:1"></div>
				<button
					type="button"
					class="plain sized_sm selectable deselectable"
					class:selected={drawer_open}
					aria-expanded={drawer_open}
					title={drawer_open ? 'hide the file details' : 'show the file details'}
					onclick={() => {
						drawer_open = !drawer_open;
					}}
				>
					<Icon data={drawer_open ? icon_double_chevron_right : icon_double_chevron_left} />
					<span class="ml_xs">details</span>
				</button>
			</div>
			{#if !editor_state.content_loaded}
				<p class="px_md py_xs mb_0 color_c_60">
					{DISKFILE_CONTENT_NOT_LOADED_MESSAGE} — read-only, it can't be edited or saved
				</p>
			{:else if diskfile.deleted_on_disk}
				<p class="px_md py_xs mb_0 color_c_60">
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
			{/if}
			<DiskfileConflictNotice
				bind:this={conflict_notice}
				{editor_state}
				onresolve={() => source_editor?.focus()}
				attrs={{ class: 'px_md py_xs' }}
			/>
			<!-- the drawer's `DiskfileActions` shows it too, but the drawer is usually closed -->
			{#if !drawer_open && editor_state.save_error !== null}
				<div class="px_md py_xs" transition:slide>
					<ErrorMessage>
						<small class="font_family_mono">save failed: {editor_state.save_error}</small>
					</ErrorMessage>
				</div>
			{/if}
			<div class="display:flex flex:1 min-height:0">
				{#if mode !== 'preview'}
					<!-- a wrapper keeps the editor its last child, so `CodeTextarea` adds no flow margin below -->
					<div class="flex:1 min-width:0 column">
						<SourceEditor
							bind:this={source_editor}
							bind:value={editor_state.current_content}
							{lang}
							focus_key={diskfile.id}
							bind:pending_element_to_focus_key={app.ui.pending_element_to_focus_key}
							placeholder={editor_state.content_loaded
								? format_placeholder(diskfile.path_relative)
								: '[content not loaded]'}
							readonly={!editor_state.content_loaded}
							wrapper_attrs={{ class: 'flex:1 min-height:0' }}
							attrs={{ class: 'height:100% border-radius:0 resize:none' }}
							save_shortcut="page"
							onsave={save}
						/>
					</div>
				{/if}
				{#if mode !== 'source'}
					<!-- alone, the preview takes the focus the editor would -->
					<MarkdownPreview
						content={editor_state.current_content}
						focus_key={mode === 'preview' ? diskfile.id : null}
						bind:pending_element_to_focus_key={app.ui.pending_element_to_focus_key}
						attrs={{ class: 'flex:1 min-width:0' }}
					/>
				{/if}
			</div>
		</div>

		{#if drawer_open}
			<div
				class="width_atmost_sm width_atleast_sm py_md overflow:auto"
				transition:slide={{ axis: 'x' }}
			>
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
								source_editor?.focus();
							}}
						/>
					</div>
				{/if}

				<DiskfilePartView {diskfile} />

				<div class="px_md">
					<TutorialForDiskfiles />
				</div>
			</div>
		{/if}
	</div>
</DiskfileContextmenu>

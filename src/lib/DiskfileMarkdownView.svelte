<script lang="ts">
	import { slide } from 'svelte/transition';
	import { inside_editable, is_editable, swallow } from '@fuzdev/fuz_util/dom.ts';
	import { mdz_parse } from '@fuzdev/mdz/mdz.ts';
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
	import MarkdownOutline from './MarkdownOutline.svelte';
	import MarkdownBrokenLinks from './MarkdownBrokenLinks.svelte';
	import { to_markdown_headings, to_markdown_links } from './markdown_links.ts';
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
		MARKDOWN_VIEW_MODE_SHORTCUTS,
		to_markdown_view_mode_for_shortcut,
		type MarkdownViewMode
	} from './markdown_view_mode.ts';

	/*

	A markdown file: its source beside a live preview, either alone (`MarkdownViewMode`), over the
	same app-level editing state as `DiskfileEditorView` — drafts, conflicts, history, and save behave
	the same. The editor view's sidebar is a drawer here, since three columns is too many; it adds the
	document's outline and broken links, which reveal their place in the preview and the source.
	Ctrl+Shift+1/2/3 switch the mode from anywhere on the page (`MARKDOWN_VIEW_MODE_SHORTCUTS`).

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

	let source_editor: { focus: () => void; place_caret: (offset: number) => void } | undefined =
		$state.raw();
	let preview:
		| {
				reveal_heading: (index: number) => boolean;
				reveal_link: (index: number, options?: { focus?: boolean }) => boolean;
		  }
		| undefined = $state.raw();
	let root_el: HTMLElement | undefined = $state.raw();
	let conflict_notice: { focus: () => boolean } | undefined = $state.raw();

	// one parse for the preview, the outline, and the link list - lazy, so the source alone with the
	// drawer closed parses nothing
	const nodes = $derived(mdz_parse(editor_state.current_content));
	const headings = $derived(to_markdown_headings(nodes));
	const links = $derived(
		to_markdown_links(nodes, { file_path: diskfile.path, index: app.diskfiles.link_index })
	);

	/** Shows the source at `offset` in the editor, and calls `reveal_in_preview` when it's shown. */
	const reveal = (offset: number, reveal_in_preview: () => void): void => {
		if (mode !== 'source') reveal_in_preview();
		if (mode !== 'preview') source_editor?.place_caret(offset);
	};

	const reveal_heading = (index: number): void => {
		const heading = headings[index];
		if (heading) reveal(heading.start, () => preview?.reveal_heading(index));
	};

	const reveal_link = (index: number): void => {
		const link = links[index];
		// the editor takes the focus when it's shown, else the link does
		if (link) reveal(link.start, () => preview?.reveal_link(index, { focus: mode === 'preview' }));
	};

	// a link from another file named a heading here - reveal it once this file shows
	$effect(() => {
		const fragment = editor_state.markdown_pending_fragment;
		if (!fragment) return;
		editor_state.markdown_pending_fragment = null;
		const index = headings.findIndex((heading) => heading.id === fragment);
		if (index !== -1) reveal_heading(index);
	});

	const set_mode = (next: MarkdownViewMode, move_focus: boolean): void => {
		editor_state.markdown_view_mode_choice = next;
		// keep the focus in the view: whichever pane it moves to takes it (see `focus_key` below)
		if (move_focus) app.ui.pending_element_to_focus_key = diskfile.id;
	};

	const handle_keydown = (event: KeyboardEvent): void => {
		// with no editor mounted, the page still saves on Ctrl+S, as the editor would
		if (mode === 'preview') handle_save_shortcut_keydown(event, save);
		if (event.defaultPrevented) return;
		const next = to_markdown_view_mode_for_shortcut(event);
		if (!next) return;
		// a modal dialog over the page keeps its keys, and the view behind it stays as it is
		if (has_open_modal_dialog()) return;
		// an input elsewhere on the page, like a chat in the desk, keeps its keys
		const target = event.target instanceof Node ? event.target : null;
		const inside = !!target && !!root_el?.contains(target);
		if (
			!inside &&
			(is_editable(target) || (target instanceof Element && inside_editable(target)))
		) {
			return;
		}
		swallow(event);
		if (event.repeat) return;
		const active = document.activeElement;
		set_mode(next, inside || !active || active === document.body);
	};

	/** Whether a modal `<dialog>` is open — fuz_ui's `Dialog` opens one with `showModal`. */
	const has_open_modal_dialog = (): boolean => {
		for (const dialog of document.querySelectorAll('dialog[open]')) {
			if (dialog.matches(':modal')) return true;
		}
		return false;
	};

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

<svelte:document onkeydown={handle_keydown} />

<DiskfileContextmenu {diskfile}>
	<div class="display:flex height:100%" bind:this={root_el}>
		<div class="flex:1 width_atleast_sm height:100% column">
			<div class="row gap_xs px_md py_xs">
				{#each MARKDOWN_VIEW_MODES as m (m)}
					<button
						type="button"
						class="plain sized_sm selectable"
						class:selected={m === mode}
						aria-pressed={m === mode}
						title="{MARKDOWN_VIEW_MODE_LABELS[m]} [{MARKDOWN_VIEW_MODE_SHORTCUTS[m]}]"
						onclick={() => set_mode(m, false)}
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
						bind:this={preview}
						{nodes}
						{links}
						path={diskfile.path}
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
					<MarkdownOutline {headings} onselect={reveal_heading} />
				</div>

				<div class="px_md mb_lg">
					<MarkdownBrokenLinks {links} onselect={reveal_link} />
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

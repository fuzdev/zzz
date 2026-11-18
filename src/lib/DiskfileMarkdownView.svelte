<script lang="ts">
	import { onDestroy } from 'svelte';
	import { slide } from 'svelte/transition';
	import { inside_editable, is_editable, swallow } from '@fuzdev/fuz_util/dom.ts';
	import { deep_equal } from '@fuzdev/fuz_util/deep_equal.ts';
	import { mdz_parse } from '@fuzdev/mdz/mdz.ts';
	import { icon_edit, icon_preview, icon_view } from '@fuzdev/fuz_ui/icons.ts';
	import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileInfo from './DiskfileInfo.svelte';
	import type { Diskfile } from './diskfile.svelte.ts';
	import type { DiskfilePath } from './diskfile_types.ts';
	import SourceEditor from './SourceEditor.svelte';
	import MarkdownPreview from './MarkdownPreview.svelte';
	import MarkdownOutline from './MarkdownOutline.svelte';
	import MarkdownBrokenLinks from './MarkdownBrokenLinks.svelte';
	import { to_markdown_headings, to_markdown_links } from './markdown_links.ts';
	import {
		find_markdown_caret_block,
		to_textarea_value,
		type MarkdownBlock,
		type MarkdownScrollAnchor,
		type MarkdownSourceRange
	} from './markdown_source_map.ts';
	import {
		MarkdownScrollSync,
		measure_element_anchor,
		measure_element_extent,
		type MarkdownScrollPane
	} from './markdown_scroll_sync.ts';
	import {
		to_followed_heading,
		to_markdown_sections,
		to_onscreen_sections,
		to_visible_source_range
	} from './markdown_outline.ts';
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
	import Icon from './Icon.svelte';
	import {
		DISKFILE_CONTENT_LOADING_MESSAGE,
		DISKFILE_UNCOVERED_LABEL,
		to_diskfile_unloaded_message
	} from './diskfile_helpers.ts';
	import { lang_for_path } from './path_lang.ts';
	import { handle_save_shortcut_keydown } from './save_shortcut.ts';
	import { has_open_modal_dialog } from './dashboard_shortcuts.ts';
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
	the same. Its details drawer (`DiskfileDetailsDrawer`) adds the document's outline and broken
	links, which reveal their place in the preview and the source.
	Ctrl+Shift+1/2/3 switch the mode from anywhere on the page (`MARKDOWN_VIEW_MODE_SHORTCUTS`).

	Split, the panes track each other through mdz's source offsets: the preview marks the block
	holding the editor's caret, a click on a preview block puts the caret at its source, and the
	panes scroll in lockstep (`MarkdownScrollSync`). The editor holds, and mdz parses, the source as
	the textarea reads it (`to_textarea_value`), so a caret and an offset index the same string.

	With the drawer open, the outline lights the sections the pane being read shows - the preview,
	or the editor alone - and brighter the one holding the caret, or with no caret the one the
	pane's scroll is at (`markdown_outline.ts`), re-read on scroll sync's frames.

	*/

	const {
		diskfile,
		onmodified
	}: {
		diskfile: Diskfile;
		onmodified?: (path: DiskfilePath) => void;
	} = $props();

	const app = frontend_context.get();

	// app-level, so switching tabs or remounting keeps the draft, selection, save state, and mode
	const editor_state = $derived(app.diskfiles.get_editor_state(diskfile));

	// loads the content on view — the editing state then keeps it current
	$effect(() => {
		void app.diskfiles.ensure_content(editor_state.diskfile);
	});

	const mode = $derived(editor_state.markdown_view_mode);
	const lang = $derived(lang_for_path(diskfile.path) ?? 'md');

	const MODE_ICONS: Record<MarkdownViewMode, SvgData> = {
		split: icon_view,
		preview: icon_preview,
		source: icon_edit
	};

	// app-wide and open by default, so the outline and the file's actions show without asking - the
	// setting, not the drawer as drawn, so a closing drawer's outline is already still
	const drawer_open = $derived(app.ui.show_diskfile_details);

	let source_editor:
		| {
				focus: () => void;
				place_caret: (offset: number) => void;
				get_scroll_element: () => HTMLTextAreaElement | undefined;
				measure_offset: (offset: number) => { top: number; bottom: number } | null;
		  }
		| undefined = $state.raw();
	let preview:
		| {
				reveal_heading: (index: number) => boolean;
				reveal_link: (index: number, options?: { focus?: boolean }) => boolean;
				get_scroll_anchors: () => ReadonlyArray<MarkdownScrollAnchor>;
				get_leaf_blocks: () => ReadonlyArray<MarkdownBlock>;
				get_heading_elements: () => ReadonlyArray<Element>;
				get_scroll_element: () => HTMLDivElement | undefined;
		  }
		| undefined = $state.raw();
	let root_el: HTMLElement | undefined = $state.raw();
	let conflict_notice: { focus: () => boolean } | undefined = $state.raw();

	// the text the editor holds - a CRLF file's line breaks read as the textarea reads them, so its
	// caret and mdz's offsets agree; typing writes the textarea's text to the draft, as it always has.
	// During a conflict it can be the disk's (`showing_disk`), read-only, so nothing is written then -
	// a click on the preview still moves the caret in the read-only editor, which writes nothing
	const source = $derived(to_textarea_value(editor_state.shown_content));

	// one parse for the preview, the outline, and the link list - lazy, so the source alone with the
	// drawer closed parses nothing
	const nodes = $derived(mdz_parse(source));
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
		app.intents.markdown_mode_set({ path: diskfile.path, mode: next });
		// keep the focus in the view: whichever pane it moves to takes it (see `focus_key` below)
		if (move_focus) app.ui.pending_element_to_focus_key = diskfile.path;
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

	// a blocked save points at the conflict notice rather than doing nothing silently
	const save = (): Promise<void> => save_from_view(editor_state, () => conflict_notice);

	// where the editor's caret is, for the preview's mark and the outline
	let caret_offset: number | null = $state.raw(null);

	// the outline's highlight: each heading's section, the ones the pane being read shows (dim), and
	// the one the reader is at (bright) - the caret's, else the one the pane's scroll follows
	const sections = $derived(to_markdown_sections(headings, source.length));
	let onscreen_sections: ReadonlySet<number> = $state.raw(new Set());
	let followed_heading = $state.raw(-1);
	const has_caret = $derived(mode !== 'preview' && caret_offset !== null);
	const current_section = $derived.by(() => {
		// the innermost section holding the caret, as the preview marks the innermost block
		const index =
			mode === 'preview' || caret_offset === null
				? followed_heading
				: find_markdown_caret_block(sections, caret_offset);
		return index === -1 ? null : index;
	});

	/** The pane being read, measured: what source range it shows, and where its headings are. */
	interface ReadingPane {
		element: HTMLElement;
		measure_visible: (view_top: number, view_bottom: number) => MarkdownSourceRange | null;
		heading_top: (index: number) => number | null;
	}

	const get_reading_pane = (): ReadingPane | null => {
		if (mode === 'source') {
			const editor = source_editor;
			const element = editor?.get_scroll_element();
			if (!editor || !element) return null;
			return {
				element,
				// each character, measured on its line - the textarea's lines are its only geometry
				measure_visible: (view_top, view_bottom) =>
					to_visible_source_range(
						source.length,
						(i) => {
							const line = editor.measure_offset(i);
							return line && { start: i, end: i + 1, top: line.top, bottom: line.bottom };
						},
						view_top,
						view_bottom
					),
				heading_top: (i) => {
					const heading = headings[i];
					return heading ? (editor.measure_offset(heading.start)?.top ?? null) : null;
				}
			};
		}
		const pane = preview;
		const element = pane?.get_scroll_element();
		if (!pane || !element) return null;
		return {
			element,
			measure_visible: (view_top, view_bottom) => {
				const leaves = pane.get_leaf_blocks();
				return to_visible_source_range(
					leaves.length,
					(i) => {
						const leaf = leaves[i]!;
						return {
							start: leaf.start,
							end: leaf.end,
							...measure_element_extent(element, leaf.element)
						};
					},
					view_top,
					view_bottom
				);
			},
			heading_top: (i) => {
				const heading = pane.get_heading_elements()[i];
				return heading ? measure_element_extent(element, heading).top : null;
			}
		};
	};

	/** Re-reads the outline's highlight from the pane being read - once per frame, drawer open. */
	const update_outline = (): void => {
		if (!drawer_open) return;
		const pane = get_reading_pane();
		const view_top = pane?.element.scrollTop ?? 0;
		const view_bottom = view_top + (pane?.element.clientHeight ?? 0);
		const onscreen = to_onscreen_sections(
			sections,
			pane?.measure_visible(view_top, view_bottom) ?? null
		);
		if (!deep_equal(onscreen, onscreen_sections)) onscreen_sections = onscreen;
		// followed only while no caret says, so a stale one never holds when the caret goes
		followed_heading =
			pane && !has_caret
				? to_followed_heading(
						headings.length,
						pane.heading_top,
						view_top,
						view_bottom,
						followed_heading,
						onscreen
					)
				: -1;
	};

	// a caret ends the followed heading at once, not on the next frame, which a caret placed with no
	// scroll never asks for - else the editor's last word as the preview replaces it would leave it held
	const handle_caret = (offset: number | null): void => {
		caret_offset = offset;
		followed_heading = -1;
	};

	const scroll_sync = new MarkdownScrollSync({
		get_editor: (): MarkdownScrollPane | null => {
			const element = mode === 'split' ? source_editor?.get_scroll_element() : undefined;
			const editor = source_editor;
			if (!element || !editor) return null;
			return {
				element,
				measure: (anchor) =>
					anchor.edge === 'top'
						? (editor.measure_offset(anchor.offset)?.top ?? null)
						: (editor.measure_offset(anchor.offset - 1)?.bottom ?? null)
			};
		},
		get_preview: (): MarkdownScrollPane | null => {
			const element = mode === 'split' ? preview?.get_scroll_element() : undefined;
			if (!element) return null;
			return { element, measure: (anchor) => measure_element_anchor(element, anchor) };
		},
		get_anchors: () => preview?.get_scroll_anchors() ?? [],
		onframe: update_outline
	});
	onDestroy(() => scroll_sync.destroy());

	/**
	 * A click in the preview puts the caret at `offset`, and the editor scrolls to match the preview
	 * rather than the other way round, so nothing moves under the pointer.
	 */
	const handle_source_click = (offset: number): void => {
		source_editor?.place_caret(offset);
		// the editor's focus made it the leader, but the preview is where the user is looking
		scroll_sync.lead('preview');
		scroll_sync.sync();
	};

	// a re-render moves the preview's blocks, so the follower realigns (on the next frame, once the
	// preview has queried its blocks) - split only, so the source alone parses nothing
	$effect(() => {
		if (mode !== 'split' || nodes.length === 0) return;
		scroll_sync.refresh();
	});

	// with the drawer open, the outline re-reads the pane being read on the next frame: when it
	// opens, after a re-render or an edit, which moves what the pane shows, and after a mode switch,
	// which shows another pane without resizing the panes' container - closed, it tracks and
	// measures nothing, and its lights clear rather than show stale for the frame before a reopen's
	// re-read
	$effect(() => {
		if (!drawer_open) {
			onscreen_sections = new Set();
			followed_heading = -1;
			return;
		}
		mode;
		nodes;
		scroll_sync.refresh();
	});

	// TODO refactor, try to remove
	$effect(() => {
		if (editor_state.content_was_modified_by_user) {
			onmodified?.(diskfile.path);
		}
	});
</script>

<svelte:document onkeydown={handle_keydown} />

<DiskfileContextmenu path={diskfile.path}>
	<!-- a stacking context, so the drawer's z-index (over the panes it slides across, the editor's
	textarea included) and the textarea's stay inside the view, under the desk menu's overlay -->
	<div class="flex height:100% isolation:isolate" bind:this={root_el}>
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
			</div>
			{#if editor_state.content_loading}
				<p class="px_md py_xs text_50">
					{DISKFILE_CONTENT_LOADING_MESSAGE} — read-only until it arrives
				</p>
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
				onresolve={() => source_editor?.focus()}
				attrs={{ class: 'px_md py_xs' }}
			/>
			<DiskfileSaveErrorNotice {editor_state} attrs={{ class: 'px_md py_xs' }} />
			<div class="flex flex:1 min-height:0" {@attach scroll_sync.attach}>
				{#if mode !== 'preview'}
					<!-- a wrapper keeps the editor its last child, so `CodeTextarea` adds no flow margin below -->
					<div class="flex:1 min-width:0 column">
						<SourceEditor
							bind:this={source_editor}
							bind:value={() => source, (value) => (editor_state.current_content = value)}
							{lang}
							focus_key={diskfile.path}
							bind:pending_element_to_focus_key={app.ui.pending_element_to_focus_key}
							placeholder={editor_state.content_loaded
								? format_placeholder(diskfile.path_relative)
								: editor_state.content_loading
									? '[loading]'
									: '[content not loaded]'}
							readonly={!editor_state.can_edit}
							wrapper_attrs={{ class: 'flex:1 min-height:0' }}
							attrs={{ class: 'height:100% border-radius:0 resize:none' }}
							save_shortcut="page"
							onsave={save}
							oncaret={handle_caret}
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
						focus_key={mode === 'preview' ? diskfile.path : null}
						bind:pending_element_to_focus_key={app.ui.pending_element_to_focus_key}
						caret_offset={mode === 'split' ? caret_offset : null}
						onsourceclick={mode === 'split' ? handle_source_click : undefined}
						attrs={{ class: 'flex:1 min-width:0' }}
					/>
				{/if}
			</div>
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
				<MarkdownOutline
					{headings}
					onscreen={onscreen_sections}
					current={current_section}
					onselect={reveal_heading}
				/>
			</div>

			<MarkdownBrokenLinks {links} onselect={reveal_link} attrs={{ class: 'px_md mb_lg' }} />

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
		</DiskfileDetailsDrawer>
	</div>
</DiskfileContextmenu>

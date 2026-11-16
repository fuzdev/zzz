<script lang="ts">
	import { flushSync, untrack } from 'svelte';
	import { swallow } from '@fuzdev/fuz_util/dom.ts';
	import {
		contextmenu_context,
		contextmenu_open
	} from '@fuzdev/fuz_ui/contextmenu_state.svelte.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfilePath } from './diskfile_types.ts';
	import DiskfileTreeitem from './DiskfileTreeitem.svelte';
	import { compute_list_window } from './list_helpers.ts';
	import { ListViewport } from './list_viewport.svelte.ts';

	/**
	 * The file explorer's tree mode: one root per indexed root, its folders
	 * (derived from the files) before its files, over `DiskfileTreeState`.
	 *
	 * The tree renders as one flat, windowed list of its visible rows
	 * (`DiskfileTreeState.rows`), not as recursive snippets: a folder opened
	 * on thousands of files then costs only the rows on screen. The rows carry
	 * their level and position in ARIA, and keyboard focus stays on the tree,
	 * naming the active row by `aria-activedescendant`, so it survives that row
	 * scrolling out of the window.
	 *
	 * Keys: Up and Down move, Right expands or moves into a folder, Left
	 * collapses or moves to the parent, Home and End jump, Enter opens a file
	 * (a permanent tab), Space previews it, and either toggles a folder; the
	 * ContextMenu key or Shift+F10 opens the active file's menu. A click
	 * previews a file and a double click opens it; a click toggles a folder.
	 *
	 * Like `SortableList`'s `windowed`, it needs the nearest scrolling ancestor
	 * to scroll it, with a constrained height.
	 *
	 * @module
	 */

	const OVERSCAN = 10;

	const { diskfiles } = frontend_context.get();
	const { tree } = diskfiles.editor;
	const get_contextmenu = contextmenu_context.get_maybe();

	const id_prefix = $props.id();

	const viewport = new ListViewport();

	const list_window = $derived(
		compute_list_window({
			count: tree.rows.length,
			row_height: viewport.row_height,
			viewport_start: viewport.viewport_start,
			viewport_end: viewport.viewport_end,
			overscan: OVERSCAN
		})
	);

	const rendered_rows = $derived(tree.rows.slice(list_window.start, list_window.end));

	const to_row_id = (index: number): string => `${id_prefix}-${index}`;

	// only a rendered row can be the active descendant
	const active_descendant = $derived(
		tree.active_index >= list_window.start && tree.active_index < list_window.end
			? to_row_id(tree.active_index)
			: undefined
	);

	// keyboard moves and `reveal` ask for the active row to scroll into view, clicks don't
	$effect(() => {
		if (!tree.scroll_request) return;
		const index = untrack(() => tree.active_index);
		if (index !== -1) viewport.scroll_into_view(index);
	});

	const onkeydown = (e: KeyboardEvent): void => {
		if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
		switch (e.key) {
			case 'ArrowDown':
				tree.move(1);
				break;
			case 'ArrowUp':
				tree.move(-1);
				break;
			case 'ArrowRight':
				tree.expand_active();
				break;
			case 'ArrowLeft':
				tree.collapse_active();
				break;
			case 'Home':
				tree.move_to(0);
				break;
			case 'End':
				tree.move_to(tree.rows.length - 1);
				break;
			case 'Enter':
				tree.open_active(true);
				break;
			case ' ':
				tree.open_active(false);
				break;
			default:
				return;
		}
		swallow(e);
	};

	const onclick = (e: MouseEvent): void => {
		const item = (e.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]');
		const row = item ? tree.rows[Number(item.dataset.index)] : undefined;
		if (!row) return;
		swallow(e);
		tree.active_key = row.key;
		if (row.kind === 'file') {
			const diskfile = diskfiles.get_by_path(row.path as DiskfilePath);
			// the second click of a double click opens the preview for good, like the list's rows
			if (diskfile) diskfiles.select(diskfile.id, e.detail === 2);
		} else if (e.detail <= 1) {
			// a double click toggles once, not twice
			tree.toggle(row);
		}
	};

	// focusing the tree gives the keyboard a row to start from: the first on screen, so the view stays
	const onfocus = (): void => {
		if (tree.active_index !== -1 || !tree.rows.length) return;
		tree.active_key = tree.rows[viewport.first_visible_index(tree.rows.length)]!.key;
	};

	// the ContextMenu key and Shift+F10 fire on the focused tree, not on the active row, whose
	// menu entries fuz_ui finds by walking up from the event's target — so open it from the row,
	// scrolled into view and rendered first, since it may be out of the window or off screen
	const oncontextmenu = (e: MouseEvent): void => {
		const index = tree.active_index;
		if (e.target !== e.currentTarget || index === -1) return;
		const contextmenu = get_contextmenu?.();
		if (!contextmenu) return;
		viewport.scroll_into_view(index);
		flushSync();
		const content = document
			.getElementById(to_row_id(index))
			?.querySelector<HTMLElement>('.menuitem');
		if (!content) return;
		const rect = content.getBoundingClientRect();
		if (contextmenu_open(content, rect.left, rect.bottom, contextmenu)) swallow(e);
	};
</script>

<ul
	role="tree"
	tabindex="0"
	aria-label="files"
	aria-activedescendant={active_descendant}
	class="diskfile-tree unstyled"
	class:active-shown={!!active_descendant}
	{@attach viewport.measure}
	style:padding-top="{list_window.start * viewport.row_height}px"
	style:padding-bottom="{(tree.rows.length - list_window.end) * viewport.row_height}px"
	{onkeydown}
	{onclick}
	{onfocus}
	{oncontextmenu}
>
	{#each rendered_rows as row, i (row.key)}
		{@const index = list_window.start + i}
		<DiskfileTreeitem {row} id={to_row_id(index)} {index} active={index === tree.active_index} />
	{/each}
</ul>

<style>
	/* the active row shows the focus ring instead, while it's rendered (`DiskfileTreeitem`) */
	.diskfile-tree.active-shown:focus-visible {
		outline: none;
	}
</style>

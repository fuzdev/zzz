<script lang="ts">
	import {
		icon_chevron_down,
		icon_chevron_right,
		icon_directory,
		icon_file
	} from '@fuzdev/fuz_ui/icons.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileTreeDirRow, DiskfileTreeFileRow } from './diskfile_tree_state.svelte.ts';
	import type { DiskfilePath } from './diskfile_types.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import DiskfileDirectoryContextmenu from './DiskfileDirectoryContextmenu.svelte';
	import DiskfileStatusLabel from './DiskfileStatusLabel.svelte';
	import Icon from './Icon.svelte';
	import {
		to_diskfile_status,
		to_diskfile_status_label,
		type DiskfileStatus
	} from './diskfile_helpers.ts';

	/**
	 * One row of `DiskfileTree`: a `treeitem` with its ARIA state, indented by
	 * its depth. Presentational — the tree handles its pointer and keyboard
	 * input, so the row is never focused itself (`aria-activedescendant`).
	 * A file row has the file contextmenu, a folder or root row the folder one
	 * (`DiskfileDirectoryContextmenu`). Each row is its own `li`, never inside
	 * another's, so a row's menu gathers no other row's entries.
	 *
	 * @module
	 */

	const {
		row,
		id,
		index,
		active = false
	}: {
		row: DiskfileTreeDirRow | DiskfileTreeFileRow;
		/** The element id the tree's `aria-activedescendant` names. */
		id: string;
		/** The row's position in `DiskfileTreeState.rows`, which the tree's click handler reads back. */
		index: number;
		/** Whether it's the row the keyboard acts on. */
		active?: boolean | undefined;
	} = $props();

	const { diskfiles } = frontend_context.get();

	const NO_STATUS: DiskfileStatus = { deleted: false, dirty: false, conflict: false };

	const diskfile = $derived(
		row.kind === 'file' ? diskfiles.get_by_path(row.path as DiskfilePath) : undefined
	);
	const status: DiskfileStatus = $derived(
		diskfile ? to_diskfile_status(diskfiles, diskfile) : NO_STATUS
	);
	const selected = $derived(!!diskfile && diskfiles.selected_file_id === diskfile.id);
</script>

<li
	role="treeitem"
	{id}
	data-index={index}
	aria-level={row.depth + 1}
	aria-setsize={row.setsize}
	aria-posinset={row.posinset}
	aria-expanded={row.kind === 'file' ? undefined : row.expanded}
	aria-selected={selected}
	aria-label={row.kind === 'file' ? to_diskfile_status_label(row.label, status) : undefined}
	title={row.kind === 'root' ? row.path : undefined}
>
	{#if diskfile}
		<DiskfileContextmenu {diskfile}>
			{@render content()}
		</DiskfileContextmenu>
	{:else if row.kind !== 'file'}
		<DiskfileDirectoryContextmenu {row}>
			{@render content()}
		</DiskfileDirectoryContextmenu>
	{:else}
		{@render content()}
	{/if}
</li>

{#snippet content()}
	<!-- the layout is here, not on the contextmenu's wrapper, which is `display: contents` -->
	<div
		class="tree-row menuitem sized_sm"
		class:selected
		class:tree-row-active={active}
		style:--depth={row.depth}
	>
		<!-- only the name truncates, so the markers after it always show -->
		<small class="row min-width:0">
			{#if row.kind === 'file'}
				<span class="chevron-space"></span>
				<Icon data={icon_file} />
				<DiskfileStatusLabel label={row.label} {status} />
			{:else}
				<Icon data={row.expanded ? icon_chevron_down : icon_chevron_right} />
				<Icon data={icon_directory} />
				<span class="ml_xs ellipsis" class:bold={row.kind === 'root'}>{row.label}</span>
			{/if}
		</small>
	</div>
{/snippet}

<style>
	.tree-row {
		padding-left: calc(var(--space_xs2) + var(--depth, 0) * var(--space_md));
	}
	/* the keyboard's row, while the keyboard is driving the tree */
	:global(.diskfile-tree:focus-visible) .tree-row-active {
		outline: var(--outline_width_focus) solid var(--outline_color);
		outline-offset: calc(-1 * var(--outline_width_focus));
	}
	/* a file's icon lines up with a folder's, past the folder's chevron */
	.chevron-space {
		flex-shrink: 0;
		width: 1em;
	}
</style>

<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import {
		icon_chevron_down,
		icon_chevron_up,
		icon_create_directory,
		icon_create_file,
		icon_directory,
		icon_terminal
	} from '@fuzdev/fuz_ui/icons.ts';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import {
		EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT,
		type DiskfileTreeDirRow
	} from './diskfile_tree_state.svelte.ts';
	import DiskfileCopyPathEntries from './DiskfileCopyPathEntries.svelte';

	/**
	 * The contextmenu of a folder or root row in the file tree. A compact row
	 * (`a/b/c`) acts on its innermost folder, the one its `path` names, except
	 * that expanding and collapsing take its whole chain, as a click does.
	 *
	 * @module
	 */

	const {
		row,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		row: DiskfileTreeDirRow;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();
	const { tree } = app.diskfiles.editor;
</script>

<Contextmenu {...rest} {entries} {children} />

{#snippet entries()}
	<ContextmenuSubmenu icon={icon_directory}>
		folder
		{#snippet menu()}
			<ContextmenuEntry icon={icon_create_file} run={() => tree.start_create(row, 'file')}>
				<span>new file…</span>
			</ContextmenuEntry>
			<ContextmenuEntry icon={icon_create_directory} run={() => tree.start_create(row, 'folder')}>
				<span>new folder…</span>
			</ContextmenuEntry>
			<ContextmenuEntry
				icon={icon_terminal}
				run={() => {
					// a terminal's `cwd` without the folder's trailing slash
					void app.terminals.open_shell(row.path.slice(0, -1));
				}}
			>
				<span>open terminal here</span>
			</ContextmenuEntry>
			<ContextmenuEntry
				icon={icon_chevron_down}
				run={() => {
					const count = tree.count_files_below(row.path);
					if (
						count > EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT &&
						// TODO @many better confirmation
						// eslint-disable-next-line no-alert
						!confirm(
							`Expand every folder below ${row.label}? It holds ${count} files, and the tree slows while they all show.`
						)
					) {
						return;
					}
					tree.expand_all_below(row);
				}}
			>
				<span>expand all below</span>
			</ContextmenuEntry>
			<ContextmenuEntry icon={icon_chevron_up} run={() => tree.collapse_below(row)}>
				<span>collapse all below</span>
			</ContextmenuEntry>
			<DiskfileCopyPathEntries path={row.path} root={row.kind === 'root'} />
			<!-- TODO rename, move, and delete folder, once the backend has actions for them -->
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

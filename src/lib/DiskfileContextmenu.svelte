<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import type { DiskfilePath } from './diskfile_types.ts';
	import type { DiskfileTreeFileRow } from './diskfile_tree_state.svelte.ts';
	import {
		icon_checkmark,
		icon_delete,
		icon_edit,
		icon_directory,
		icon_file,
		icon_remove,
		icon_terminal,
		icon_view
	} from '@fuzdev/fuz_ui/icons.ts';
	import { frontend_context } from './frontend.svelte.ts';
	import { delete_diskfile, prompt_rename_diskfile } from './diskfile_helpers.ts';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import DiskfileCopyPathEntries from './DiskfileCopyPathEntries.svelte';
	import DiskfileHold from './DiskfileHold.svelte';
	import { to_diskfile_content_kind } from './diskfile_content_kind.ts';
	import {
		MARKDOWN_VIEW_MODES,
		MARKDOWN_VIEW_MODE_LABELS,
		to_default_markdown_view_mode
	} from './markdown_view_mode.ts';

	const {
		path,
		reveal_in_tree = false,
		tree_row,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		/** The file's path — no menu when `null` or `undefined`. */
		path: DiskfilePath | null | undefined;
		/**
		 * Whether to offer "reveal in tree" — on the files page's list rows and
		 * tabs, beside the explorer, not on the tree's own rows.
		 */
		reveal_in_tree?: boolean | undefined;
		/**
		 * The tree row the menu was opened from, if any: "rename file" renames
		 * there, inline (`DiskfileTreeState.start_rename`), not by a prompt.
		 */
		tree_row?: DiskfileTreeFileRow | undefined;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;

	// only the content entries need the cell, held while the menu's open (`DiskfileHold`)
	const diskfile = $derived(path ? diskfiles.peek(path) : undefined);

	// the folder holding `path`, without a trailing slash, as a terminal's `cwd`
	const to_parent_dir = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
</script>

{#if path}
	<Contextmenu {...rest} {entries} {children} />
{:else}
	{@render children()}
{/if}

{#snippet entries()}
	{#if path}
		<!-- held while the menu's open, so its content entries have the file's cell to read -->
		<DiskfileHold {path}>
			{@const { tabs } = diskfiles.editor}
			{@const tab = tabs.by_path.get(path)}
			{@const selected = tabs.selected_path === path}
			<ContextmenuSubmenu icon={icon_file}>
				file
				{#snippet menu()}
					<!-- TODO maybe show disabled versions? changing what appears isn't great -->
					{#if !selected || tab?.is_preview}
						<ContextmenuEntry
							icon={icon_file}
							run={() => {
								app.intents.tab_open({ path, permanent: true });
							}}
						>
							<span>select tab</span>
						</ContextmenuEntry>
					{/if}

					{#if !tab || (!selected && tab.is_preview)}
						<ContextmenuEntry
							icon={icon_file}
							run={() => {
								app.intents.tab_open({ path });
							}}
						>
							<span>preview tab</span>
						</ContextmenuEntry>
					{/if}

					{#if tab}
						<ContextmenuEntry
							icon={icon_remove}
							run={() => {
								app.intents.tab_close({ path });
							}}
						>
							<span>close tab</span>
						</ContextmenuEntry>
					{/if}

					<DiskfileCopyPathEntries {path} />

					<!-- loaded on click when it isn't yet; kept after a failed read, to say why;
					never for an empty file, by its content once loaded, else its size on disk -->
					{#if diskfile}
						{@const file = diskfile}
						{#if (file.content_status !== 'unloadable' || file.content_error !== null) &&
							(file.content === null ? file.size !== 0 : file.content !== '')
						}
							<ContextmenuEntryCopyToClipboard
								content={file.content ?? undefined}
								load_content={file.content_status === 'loaded'
									? undefined
									: () => diskfiles.load_content(file)}
								label="copy file content"
								preview={file.content_preview}
							/>
						{/if}
					{/if}

					{#if reveal_in_tree}
						<ContextmenuEntry
							icon={icon_directory}
							run={() => {
								app.intents.file_reveal({ path });
							}}
						>
							<span>reveal in tree</span>
						</ContextmenuEntry>
					{/if}

					<!-- a file deleted on disk may have taken its folder with it -->
					{#if !diskfile?.deleted_on_disk}
						<ContextmenuEntry
							icon={icon_terminal}
							run={() => {
								void app.terminals.open_shell(to_parent_dir(path));
							}}
						>
							<span>open terminal in its folder</span>
						</ContextmenuEntry>
					{/if}

					<ContextmenuEntry
						icon={icon_delete}
						run={async () => {
							// TODO @many better confirmation
							// eslint-disable-next-line no-alert
							if (confirm(`Are you sure you want to delete ${diskfiles.to_relative_path(path)}?`)) {
								await delete_diskfile(diskfiles, path);
							}
						}}
					>
						<span>delete file</span>
					</ContextmenuEntry>

					{#if diskfiles.can_rename(path)}
						<ContextmenuEntry
							icon={icon_edit}
							run={async () => {
								if (tree_row) {
									diskfiles.editor.tree.start_rename(tree_row);
								} else {
									await prompt_rename_diskfile(app.intents, path);
								}
							}}
						>
							<span>rename file</span>
						</ContextmenuEntry>
					{/if}

					<!-- TODO move, once the backend has an action for it -->
				{/snippet}
			</ContextmenuSubmenu>
			{#if to_diskfile_content_kind(path) === 'markdown'}
				{@const current_mode =
					diskfiles.markdown_view_modes.get(path) ??
					to_default_markdown_view_mode(diskfile?.content_status !== 'unloadable')}
				<!-- a choice is kept by path, so no editing state is made for it -->
				<ContextmenuSubmenu icon={icon_view}>
					view
					{#snippet menu()}
						{#each MARKDOWN_VIEW_MODES as mode (mode)}
							<ContextmenuEntry
								icon={mode === current_mode ? icon_checkmark : icon_view}
								run={() => {
									app.intents.markdown_mode_set({ path, mode });
								}}
							>
								<span>{MARKDOWN_VIEW_MODE_LABELS[mode]}</span>
							</ContextmenuEntry>
						{/each}
					{/snippet}
				</ContextmenuSubmenu>
			{/if}
		</DiskfileHold>
	{/if}
{/snippet}

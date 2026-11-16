<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import type { Diskfile } from './diskfile.svelte.ts';
	import {
		icon_checkmark,
		icon_delete,
		icon_directory,
		icon_file,
		icon_remove,
		icon_terminal,
		icon_view
	} from '@fuzdev/fuz_ui/icons.ts';
	import { frontend_context } from './frontend.svelte.ts';
	import { delete_diskfile } from './diskfile_helpers.ts';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import DiskfileCopyPathEntries from './DiskfileCopyPathEntries.svelte';
	import { to_diskfile_content_kind } from './diskfile_content_kind.ts';
	import {
		MARKDOWN_VIEW_MODES,
		MARKDOWN_VIEW_MODE_LABELS,
		to_default_markdown_view_mode
	} from './markdown_view_mode.ts';

	const {
		diskfile,
		reveal_in_tree = false,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		diskfile: Diskfile | null | undefined;
		/**
		 * Whether to offer "reveal in tree" — on the files page's list rows and
		 * tabs, beside the explorer, not on the tree's own rows.
		 */
		reveal_in_tree?: boolean | undefined;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	// the folder holding `path`, without a trailing slash, as a terminal's `cwd`
	const to_parent_dir = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
</script>

{#if diskfile}
	<Contextmenu {...rest} {entries} {children} />
{:else}
	{@render children()}
{/if}

{#snippet entries()}
	{#if diskfile}
		{@const { diskfiles } = diskfile.app}
		{@const { tabs } = diskfiles.editor}
		{@const tab = tabs.by_diskfile_id.get(diskfile.id)}
		{@const selected = diskfile === tabs.selected_tab?.diskfile}
		<ContextmenuSubmenu icon={icon_file}>
			file
			{#snippet menu()}
				<!-- TODO maybe show disabled versions? changing what appears isn't great -->
				{#if !selected || tab?.is_preview}
					<ContextmenuEntry
						icon={icon_file}
						run={() => {
							diskfiles.select(diskfile.id, true);
						}}
					>
						<span>select tab</span>
					</ContextmenuEntry>
				{/if}

				{#if !tab || (!selected && tab.is_preview)}
					<ContextmenuEntry
						icon={icon_file}
						run={() => {
							diskfiles.select(diskfile.id, false);
						}}
					>
						<span>preview tab</span>
					</ContextmenuEntry>
				{/if}

				{#if tab}
					<ContextmenuEntry
						icon={icon_remove}
						run={() => {
							diskfiles.editor.request_close_tab(tab.id);
						}}
					>
						<span>close tab</span>
					</ContextmenuEntry>
				{/if}

				<DiskfileCopyPathEntries path={diskfile.path} />

				<!-- loaded on click when it isn't yet; kept after a failed read, to say why;
				never for an empty file, by its content once loaded, else its size on disk -->
				{#if (diskfile.content_status !== 'unloadable' || diskfile.content_error !== null) &&
					(diskfile.content === null ? diskfile.size !== 0 : diskfile.content !== '')
				}
					<ContextmenuEntryCopyToClipboard
						content={diskfile.content ?? undefined}
						load_content={diskfile.content_status === 'loaded'
							? undefined
							: () => diskfiles.load_content(diskfile)}
						label="copy file content"
						preview={diskfile.content_preview}
					/>
				{/if}

				{#if reveal_in_tree}
					<ContextmenuEntry
						icon={icon_directory}
						run={() => {
							diskfiles.editor.reveal_in_tree(diskfile.path);
						}}
					>
						<span>reveal in tree</span>
					</ContextmenuEntry>
				{/if}

				<!-- a file deleted on disk may have taken its folder with it -->
				{#if !diskfile.deleted_on_disk}
					<ContextmenuEntry
						icon={icon_terminal}
						run={() => {
							void app.terminals.open_shell(to_parent_dir(diskfile.path));
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
						if (confirm(`Are you sure you want to delete ${diskfile.path_relative}?`)) {
							await delete_diskfile(app.diskfiles, diskfile);
						}
					}}
				>
					<span>delete file</span>
				</ContextmenuEntry>

				<!-- TODO rename and move, once the backend has actions for them -->
			{/snippet}
		</ContextmenuSubmenu>
		{#if to_diskfile_content_kind(diskfile.path) === 'markdown'}
			{@const current_mode =
				diskfiles.find_editor_state(diskfile.id)?.markdown_view_mode ??
				to_default_markdown_view_mode(diskfile.content_status !== 'unloadable')}
			<!-- rendering only looks the editing state up: it's created on a choice, never by opening the menu -->
			<ContextmenuSubmenu icon={icon_view}>
				view
				{#snippet menu()}
					{#each MARKDOWN_VIEW_MODES as mode (mode)}
						<ContextmenuEntry
							icon={mode === current_mode ? icon_checkmark : icon_view}
							run={() => {
								diskfiles.get_editor_state(diskfile).markdown_view_mode_choice = mode;
							}}
						>
							<span>{MARKDOWN_VIEW_MODE_LABELS[mode]}</span>
						</ContextmenuEntry>
					{/each}
				{/snippet}
			</ContextmenuSubmenu>
		{/if}
	{/if}
{/snippet}

<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import type {Diskfile} from './diskfile.svelte.js';
	import {icon_delete, icon_file, icon_remove} from '@fuzdev/fuz_ui/icons.js';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';

	const {
		diskfile,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		diskfile: Diskfile | null | undefined;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();
</script>

{#if diskfile}
	<Contextmenu {...rest} {entries} {children} />
{:else}
	{@render children()}
{/if}

{#snippet entries()}
	{#if diskfile}
		{@const {diskfiles} = diskfile.app}
		{@const {tabs} = diskfiles.editor}
		{@const tab = tabs.by_diskfile_id.get(diskfile.id)}
		{@const selected = diskfile === tabs.selected_tab?.diskfile}
		<ContextmenuSubmenu>
			{#snippet icon()}<Svg data={icon_file} />{/snippet}
			file
			{#snippet menu()}
				<!-- TODO maybe show disabled versions? changing what appears isn't great -->
				{#if !selected || tab?.is_preview}
					<ContextmenuEntry
						run={() => {
							diskfiles.select(diskfile.id, true);
						}}
					>
						{#snippet icon()}<Svg data={icon_file} />{/snippet}
						<span>select tab</span>
					</ContextmenuEntry>
				{/if}

				{#if !tab || (!selected && tab.is_preview)}
					<ContextmenuEntry
						run={() => {
							diskfiles.select(diskfile.id, false);
						}}
					>
						{#snippet icon()}<Svg data={icon_file} />{/snippet}
						<span>preview tab</span>
					</ContextmenuEntry>
				{/if}

				{#if tab}
					<ContextmenuEntry
						run={() => {
							diskfiles.editor.close_tab(tab.id);
						}}
					>
						{#snippet icon()}<Svg data={icon_remove} />{/snippet}
						<span>close tab</span>
					</ContextmenuEntry>
				{/if}

				{#if diskfile.path_relative}
					<ContextmenuEntryCopyToClipboard
						content={diskfile.path_relative}
						label="copy file path"
					/>
				{/if}

				{#if diskfile.content}
					<ContextmenuEntryCopyToClipboard
						content={diskfile.content}
						label="copy file content"
						preview={diskfile.content_preview}
					/>
				{/if}
				<ContextmenuEntry
					run={async () => {
						// TODO @many better confirmation
						// eslint-disable-next-line no-alert
						if (confirm(`Are you sure you want to delete ${diskfile.path_relative}?`)) {
							await app.diskfiles.delete(diskfile.path);
						}
					}}
				>
					{#snippet icon()}<Svg data={icon_delete} />{/snippet}
					<span>delete file</span>
				</ContextmenuEntry>
			{/snippet}
		</ContextmenuSubmenu>
	{/if}
{/snippet}

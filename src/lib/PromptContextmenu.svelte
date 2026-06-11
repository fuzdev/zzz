<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import {Part} from './part.svelte.js';
	import type {Prompt} from './prompt.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import {
		icon_delete,
		icon_file,
		icon_part,
		icon_prompt,
		icon_remove,
	} from '@fuzdev/fuz_ui/icons.js';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';

	const {
		prompt,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		prompt: Prompt;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	let show_diskfile_picker = $state.raw(false);
</script>

<Contextmenu {...rest} {entries} />

{#snippet entries()}
	<ContextmenuSubmenu>
		{#snippet icon()}<Svg data={icon_prompt} />{/snippet}
		prompt
		{#snippet menu()}
			<!-- TODO @many maybe a copy submenu on this item with copy id, name, etc, leverage generic cells -->
			<ContextmenuEntryCopyToClipboard
				content={prompt.content}
				label="copy content"
				preview={prompt.content_preview}
			/>

			<ContextmenuEntry
				run={() => {
					prompt.add_part(
						Part.create(app, {
							type: 'text',
							content: '',
						}),
					);
				}}
			>
				{#snippet icon()}<Svg data={icon_part} />{/snippet}
				<span>add text part</span>
			</ContextmenuEntry>
			<ContextmenuEntry
				run={() => {
					if (!app.diskfiles.items.size) {
						alert('No files available. Add files first.'); // eslint-disable-line no-alert
						return;
					}

					show_diskfile_picker = true;
				}}
			>
				{#snippet icon()}<Svg data={icon_file} />{/snippet}
				<span>add file part</span>
			</ContextmenuEntry>
			{#if prompt.parts.length}
				<ContextmenuEntry run={() => prompt.remove_all_parts()}>
					{#snippet icon()}<Svg data={icon_remove} />{/snippet}
					<span>remove all parts</span>
				</ContextmenuEntry>
			{/if}
			<!-- <ContextmenuEntry
				run={() => {
					// TODO implement
					// prompt.rename() after part name picker
				}}
			>
				{#snippet icon()}<Svg data={icon_edit} />{/snippet}
				<span>Rename prompt</span>
			</ContextmenuEntry> -->
			<ContextmenuEntry
				run={() => {
					// TODO confirm dialog that shows the prompt's summary
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete prompt "${prompt.name}"?`)) {
						app.prompts.remove(prompt);
					}
				}}
			>
				{#snippet icon()}<Svg data={icon_delete} />{/snippet}
				<span>delete prompt</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

<DiskfilePickerDialog
	bind:show={show_diskfile_picker}
	onpick={(diskfile) => {
		if (!diskfile) return false;

		prompt.add_part(
			Part.create(app, {
				type: 'diskfile',
				path: diskfile.path,
			}),
		);
		return true;
	}}
/>

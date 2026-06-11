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
	<ContextmenuSubmenu icon={icon_prompt}>
		prompt
		{#snippet menu()}
			<!-- TODO @many maybe a copy submenu on this item with copy id, name, etc, leverage generic cells -->
			<ContextmenuEntryCopyToClipboard
				content={prompt.content}
				label="copy content"
				preview={prompt.content_preview}
			/>

			<ContextmenuEntry
				icon={icon_part}
				run={() => {
					prompt.add_part(
						Part.create(app, {
							type: 'text',
							content: '',
						}),
					);
				}}
			>
				<span>add text part</span>
			</ContextmenuEntry>
			<ContextmenuEntry
				icon={icon_file}
				run={() => {
					if (!app.diskfiles.items.size) {
						alert('No files available. Add files first.'); // eslint-disable-line no-alert
						return;
					}

					show_diskfile_picker = true;
				}}
			>
				<span>add file part</span>
			</ContextmenuEntry>
			{#if prompt.parts.length}
				<ContextmenuEntry icon={icon_remove} run={() => prompt.remove_all_parts()}>
					<span>remove all parts</span>
				</ContextmenuEntry>
			{/if}
			<!-- <ContextmenuEntry
				icon={icon_edit}
				run={() => {
					// TODO implement
					// prompt.rename() after part name picker
				}}
			>
				<span>Rename prompt</span>
			</ContextmenuEntry> -->
			<ContextmenuEntry
				icon={icon_delete}
				run={() => {
					// TODO confirm dialog that shows the prompt's summary
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete prompt "${prompt.name}"?`)) {
						app.prompts.remove(prompt);
					}
				}}
			>
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

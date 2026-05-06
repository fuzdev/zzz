<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import {Part} from './part.svelte.js';
	import type {Prompt} from './prompt.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import {GLYPH_PART, GLYPH_DELETE, GLYPH_FILE, GLYPH_PROMPT, GLYPH_REMOVE} from './glyphs.js';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import Glyph from './Glyph.svelte';

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
		{#snippet icon()}<Glyph glyph={GLYPH_PROMPT} />{/snippet}
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
				{#snippet icon()}<Glyph glyph={GLYPH_PART} />{/snippet}
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
				{#snippet icon()}<Glyph glyph={GLYPH_FILE} />{/snippet}
				<span>add file part</span>
			</ContextmenuEntry>
			{#if prompt.parts.length}
				<ContextmenuEntry run={() => prompt.remove_all_parts()}>
					{#snippet icon()}<Glyph glyph={GLYPH_REMOVE} />{/snippet}
					<span>remove all parts</span>
				</ContextmenuEntry>
			{/if}
			<!-- <ContextmenuEntry
				run={() => {
					// TODO implement
					// prompt.rename() after part name picker
				}}
			>
				{#snippet icon()}<Glyph text={GLYPH_EDIT} />{/snippet}
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
				{#snippet icon()}<Glyph glyph={GLYPH_DELETE} />{/snippet}
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

<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';

	import type {PartUnion} from './part.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import {GLYPH_PART, GLYPH_DELETE, GLYPH_EDIT} from './glyphs.js';
	import Glyph from './Glyph.svelte';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import PartView from './PartView.svelte';
	import {get_part_type_glyph} from './part_helpers.js';
	import ContextmenuEntryToggle from './ContextmenuEntryToggle.svelte';

	const {
		part,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		part: PartUnion;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	let show_editor = $state(false);
</script>

<Contextmenu {...rest} {entries} />

{#snippet entries()}
	<ContextmenuSubmenu>
		{#snippet icon()}{get_part_type_glyph(part)}{/snippet}
		part

		{#snippet menu()}
			<!-- TODO @many maybe a copy submenu on this item with copy id, name, etc, leverage generic cells -->
			{#if part.content !== null && part.content !== undefined}
				<ContextmenuEntryCopyToClipboard
					content={part.content}
					label="copy content"
					preview={part.content_preview ?? undefined}
				/>
			{/if}

			<ContextmenuEntryToggle bind:enabled={part.enabled} label="part" />

			<ContextmenuEntry
				run={() => {
					show_editor = true;
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_EDIT} />{/snippet}
				<span>edit part</span>
			</ContextmenuEntry>

			<ContextmenuEntry
				run={() => {
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete this part "${part.name || 'unnamed'}"?`)) {
						app.parts.remove(part.id);
					}
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_DELETE} />{/snippet}
				<span>delete part</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

{#if show_editor}
	<Dialog onclose={() => (show_editor = false)}>
		<div class="pane p_md width_atmost_md mx_auto">
			<h2 class="mt_0 mb_sm"><Glyph glyph={GLYPH_PART} /> edit part</h2>
			<PartView {part} />
		</div>
	</Dialog>
{/if}

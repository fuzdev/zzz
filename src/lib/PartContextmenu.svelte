<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.ts';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import DialogContent from '@fuzdev/fuz_ui/DialogContent.svelte';

	import type {PartUnion} from './part.svelte.ts';
	import {frontend_context} from './frontend.svelte.ts';
	import {icon_delete, icon_edit, icon_part} from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import PartView from './PartView.svelte';
	import {get_part_type_icon} from './part_helpers.ts';
	import ContextmenuEntryToggle from './ContextmenuEntryToggle.svelte';

	const {
		part,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		part: PartUnion;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	let show_editor = $state.raw(false);
</script>

<Contextmenu {...rest} {entries} />

{#snippet entries()}
	<ContextmenuSubmenu icon={get_part_type_icon(part)}>
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
				icon={icon_edit}
				run={() => {
					show_editor = true;
				}}
			>
				<span>edit part</span>
			</ContextmenuEntry>

			<ContextmenuEntry
				icon={icon_delete}
				run={() => {
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete this part "${part.name || 'unnamed'}"?`)) {
						app.parts.remove(part.id);
					}
				}}
			>
				<span>delete part</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

{#if show_editor}
	<Dialog onclose={() => (show_editor = false)}>
		<DialogContent>
			<h2 class="mt_0 mb_sm"><Svg data={icon_part} /> edit part</h2>
			<PartView {part} />
		</DialogContent>
	</Dialog>
{/if}

<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import DialogContent from '@fuzdev/fuz_ui/DialogContent.svelte';

	import type { Turn } from './turn.svelte.ts';
	import { icon_edit, icon_turn } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import TurnView from './TurnView.svelte';

	const {
		turn,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		turn: Turn;
		children: Snippet;
	} = $props();

	let show_editor = $state.raw(false);
</script>

<Contextmenu {...rest} {entries} />

{#snippet entries()}
	<ContextmenuSubmenu icon={icon_turn}>
		turn
		{#snippet menu()}
			{#if turn.content}
				<ContextmenuEntryCopyToClipboard
					content={turn.content}
					label="copy content"
					preview={turn.content}
				/>
			{/if}

			<ContextmenuEntry
				icon={icon_edit}
				run={() => {
					show_editor = true;
				}}
			>
				<span>edit content</span>
			</ContextmenuEntry>

			{#if turn.request}
				<ContextmenuEntryCopyToClipboard
					content={() => JSON.stringify(turn.request, null, 2)}
					label="copy request data"
					preview=""
				/>
			{/if}

			{#if turn.response}
				<ContextmenuEntryCopyToClipboard
					content={() => JSON.stringify(turn.response, null, 2)}
					label="copy response data"
					preview=""
				/>
			{/if}
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

{#if show_editor}
	<Dialog onclose={() => (show_editor = false)}>
		<DialogContent>
			<h2 class="mt_0 mb_sm"><Svg data={icon_turn} /> edit turn</h2>
			<TurnView {turn} />
		</DialogContent>
	</Dialog>
{/if}

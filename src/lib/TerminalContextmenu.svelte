<script lang="ts">
	import type { Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import { icon_paste } from '@fuzdev/fuz_ui/icons.ts';
	import type { Thunk } from '@fuzdev/fuz_util/function.ts';

	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import { read_clipboard_text } from './terminal_paste.ts';

	const {
		get_terminal_text,
		paste,
		read_clipboard = read_clipboard_text,
		display_command,
		children
	}: {
		get_terminal_text: Thunk<string> | null;
		/**
		 * The view's paste (`TerminalView`'s `get_paste`), or `null` while the
		 * terminal takes no input, which disables the entry.
		 */
		paste: ((text: Promise<string>) => unknown) | null;
		/** Reads the clipboard's text; defaults to `read_clipboard_text`. */
		read_clipboard?: () => Promise<string>;
		display_command: string;
		children: Snippet;
	} = $props();

	// the read starts here, in the activation from the click or key press: a
	// browser allows it only then. The view reports how the paste went, so the
	// menu closes at once
	const paste_clipboard = (): void => {
		if (!paste) return;
		void paste(read_clipboard());
	};
</script>

<Contextmenu {entries} {children} />

{#snippet entries()}
	<ContextmenuEntry icon={icon_paste} run={paste_clipboard} disabled={!paste}>
		<span>paste</span>
	</ContextmenuEntry>
	{#if get_terminal_text}
		<ContextmenuEntryCopyToClipboard content={get_terminal_text} label="copy output" />
	{/if}
	<ContextmenuEntryCopyToClipboard content={'$ ' + display_command} label="copy command" />
{/snippet}

<script lang="ts">
	// Test harness: `TerminalContextmenu` under a `ContextmenuRoot`, around a target to right-click.
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import TerminalContextmenu from '#lib/TerminalContextmenu.svelte';

	const {
		paste,
		read_clipboard,
		display_command = 'sh'
	}: {
		paste: ((text: Promise<string>) => unknown) | null;
		read_clipboard: () => Promise<string>;
		display_command?: string;
	} = $props();
</script>

<ContextmenuRoot>
	<TerminalContextmenu get_terminal_text={null} {paste} {read_clipboard} {display_command}>
		<span class="contextmenu-target">terminal</span>
	</TerminalContextmenu>
</ContextmenuRoot>

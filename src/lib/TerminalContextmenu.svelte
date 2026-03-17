<script lang="ts">
	import type {Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import type {Thunk} from '@fuzdev/fuz_util/function.js';

	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';

	interface Props {
		get_terminal_text: Thunk<string> | null;
		display_command: string;
		children: Snippet;
	}

	const {get_terminal_text, display_command, children}: Props = $props();
</script>

<Contextmenu {entries} {children} />

{#snippet entries()}
	{#if get_terminal_text}
		<ContextmenuEntryCopyToClipboard content={get_terminal_text} label="copy output" />
	{/if}
	<ContextmenuEntryCopyToClipboard content={'$ ' + display_command} label="copy command" />
{/snippet}

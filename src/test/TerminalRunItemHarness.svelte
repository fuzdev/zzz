<script lang="ts">
	// Test harness: `TerminalRunItem` under a `ContextmenuRoot` and test emulator deps.
	import { untrack } from 'svelte';
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import TerminalRunItem from '#lib/TerminalRunItem.svelte';
	import {
		fuz_terminal_deps_context,
		type FuzTerminalDeps
	} from '#lib/fuz_terminal/fuz_terminal_deps.ts';
	import type { Terminal } from '#lib/terminal.svelte.ts';

	const { deps, terminal }: { deps: FuzTerminalDeps; terminal: Terminal } = $props();

	fuz_terminal_deps_context.set(untrack(() => deps));
</script>

<ContextmenuRoot>
	<TerminalRunItem {terminal} />
</ContextmenuRoot>

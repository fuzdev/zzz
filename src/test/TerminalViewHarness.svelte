<script lang="ts">
	// Test harness: mounts `TerminalView` under test emulator deps, remounted per
	// process as `TerminalRunItem` does, handing back the parent's text getter.
	import { untrack } from 'svelte';

	import TerminalView from '#lib/TerminalView.svelte';
	import {
		fuz_terminal_deps_context,
		type FuzTerminalDeps
	} from '#lib/fuz_terminal/fuz_terminal_deps.ts';
	import type { Terminal } from '#lib/terminal.svelte.ts';

	const {
		deps,
		terminal,
		load_module,
		get_text
	}: {
		deps: FuzTerminalDeps;
		terminal: Terminal;
		load_module: () => Promise<WebAssembly.Module>;
		get_text: (fn: () => string) => void;
	} = $props();

	fuz_terminal_deps_context.set(untrack(() => deps));
</script>

{#key terminal.run}
	<TerminalView {terminal} {load_module} {get_text} />
{/key}

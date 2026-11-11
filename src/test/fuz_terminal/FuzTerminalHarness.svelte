<script lang="ts">
	// Test harness: mounts `FuzTerminal` under test deps, handing its instance back.
	import { untrack } from 'svelte';

	import FuzTerminal from '#lib/fuz_terminal/FuzTerminal.svelte';
	import {
		fuz_terminal_deps_context,
		type FuzTerminalDeps
	} from '#lib/fuz_terminal/fuz_terminal_deps.ts';
	import type { FuzTerminalOptions } from '#lib/fuz_terminal/fuz_terminal_state.svelte.ts';

	const {
		deps,
		props,
		oninstance
	}: {
		deps: FuzTerminalDeps;
		props: FuzTerminalOptions & { label?: string };
		oninstance: (instance: FuzTerminal) => void;
	} = $props();

	fuz_terminal_deps_context.set(untrack(() => deps));

	let instance: FuzTerminal | undefined = $state.raw();

	// once: nothing the callback reads is tracked
	$effect(() => {
		const mounted = instance;
		if (mounted) untrack(() => oninstance(mounted));
	});
</script>

<FuzTerminal bind:this={instance} {...props} />

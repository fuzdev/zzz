<script lang="ts">
	// Test harness: runs callbacks during component init, in `onMount`, and in an
	// `$effect` — the scopes whose effects own anything created synchronously in them.
	import { onMount, untrack } from 'svelte';

	const {
		oninit,
		onmount,
		oneffect
	}: {
		oninit?: () => void;
		onmount?: () => void;
		oneffect?: () => void;
	} = $props();

	untrack(() => oninit?.());

	onMount(() => {
		onmount?.();
	});

	$effect(() => {
		untrack(() => oneffect?.());
	});
</script>

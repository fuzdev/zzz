<script lang="ts">
	import type {Prompt} from './prompt.svelte.ts';
	import ContentStats from './ContentStats.svelte';

	const {
		prompt,
	}: {
		prompt: Prompt;
	} = $props();

	const token_count = $derived(prompt.token_count);
</script>

<ContentStats {token_count} />

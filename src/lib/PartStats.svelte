<script lang="ts">
	import type {PartUnion} from './part.svelte.ts';
	import ContentStats from './ContentStats.svelte';

	const {
		part,
	}: {
		part: PartUnion;
	} = $props();

	const token_count = $derived(part.token_count ?? 0);
</script>

<ContentStats {token_count} />

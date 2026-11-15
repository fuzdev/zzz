<script lang="ts">
	// Test harness: mounts `component` with an mdz `code` component that renders each inline code
	// span as a link (`MdzCodeLink`), as an injected component that auto-links identifiers would.
	import type { Component } from 'svelte';
	import { mdz_code_context } from '@fuzdev/mdz/mdz_contexts.ts';

	import MdzCodeLink from './MdzCodeLink.svelte';

	const {
		component: Mounted,
		props
	}: {
		component: Component<any>;
		props: Record<string, unknown>;
	} = $props();

	mdz_code_context.set(() => MdzCodeLink);
</script>

<Mounted {...props} />

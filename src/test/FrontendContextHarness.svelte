<script lang="ts">
	// Test harness: mounts `component` inside `frontend_context`.
	import { untrack, type Component } from 'svelte';

	import { frontend_context, type Frontend } from '$lib/frontend.svelte.ts';

	const {
		app,
		component: Mounted,
		props
	}: {
		app: Frontend;
		component: Component<any>;
		props: Record<string, unknown>;
	} = $props();

	frontend_context.set(untrack(() => app));
</script>

<Mounted {...props} />

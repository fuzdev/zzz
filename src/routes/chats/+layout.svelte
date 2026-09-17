<script lang="ts">
	import type { Snippet } from 'svelte';

	import { frontend_context } from '$lib/frontend.svelte.ts';

	const {
		children
	}: {
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	// TODO refactor? probably belongs at the layout or page level bc it owns focus, but maybe improve?
	$effect(() => {
		if (app.chats.selected) {
			app.ui.pending_element_to_focus_key = app.chats.selected.id;
		}
	});
</script>

{@render children()}

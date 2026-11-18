<script lang="ts">
	import CommandPalette from '#lib/CommandPalette.svelte';
	import { frontend_context } from '#lib/frontend.svelte.ts';

	import { palette_close_trigger } from './palette_close_trigger.svelte.ts';

	/**
	 * The palette inside a component whose effect closes it through the
	 * intent — an effect that runs in its own flush, after the palette's markup
	 * has updated.
	 */

	const app = frontend_context.get();

	$effect(() => {
		if (palette_close_trigger.requested) app.intents.palette_toggle({ show: false });
	});
</script>

<CommandPalette />

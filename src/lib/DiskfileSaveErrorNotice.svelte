<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
	import ErrorMessage from './ErrorMessage.svelte';

	const {
		editor_state,
		attrs
	}: {
		editor_state: DiskfileEditorState;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	const app = frontend_context.get();
</script>

<!-- a file view's save error, beside its editor - the details drawer's `DiskfileActions` shows it
too, so this one shows only with the drawer closed, where a save from Ctrl+S would otherwise fail
unseen; no transition, so it never doubles up with the drawer's copy while that slides, and the
editor resizes once, as it does for the drawer -->
{#if !app.ui.show_diskfile_details && editor_state.save_error !== null}
	<div {...attrs}>
		<ErrorMessage>
			<small class="font_family_mono">save failed: {editor_state.save_error}</small>
		</ErrorMessage>
	</div>
{/if}

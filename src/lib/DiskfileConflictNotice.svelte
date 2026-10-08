<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';

	const {
		editor_state,
		onresolve,
		attrs
	}: {
		editor_state: DiskfileEditorState;
		/** Called after the user overwrites or reloads, e.g. to refocus the editor. */
		onresolve?: (() => void) | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	let notice_el: HTMLDivElement | undefined = $state.raw();

	/**
	 * Moves focus to the notice, so a blocked save (Ctrl+S) points at it and
	 * screen readers read it again. Returns whether a notice is shown.
	 */
	export const focus = (): boolean => {
		if (!notice_el) return false;
		notice_el.focus();
		return true;
	};
</script>

<!-- the file changed on disk under the user's edit: saving waits for an explicit choice -->
<!-- TODO a "compare" diff view, once zzz has one — for now both versions are in the history -->
{#if editor_state.has_conflict}
	<div {...attrs} role="alert" tabindex="-1" bind:this={notice_el}>
		<small class="color_c_50">
			changed on disk since you edited it — saving is paused so that change isn't overwritten; both
			versions are in the history
		</small>
		<div class="display:flex gap_xs mt_xs">
			<button
				type="button"
				class="sized_sm"
				disabled={editor_state.saving}
				title={editor_state.has_unsaved_edits
					? 'show your draft and save it over the file on disk'
					: 'save the version shown over the file on disk'}
				onclick={async () => {
					// the draft, even if the editor shows an older entry (it's shown first)
					await editor_state.save_draft({ overwrite: true });
					onresolve?.();
				}}
			>
				{editor_state.has_unsaved_edits
					? 'overwrite with your draft'
					: 'overwrite with this version'}
			</button>
			<button
				type="button"
				class="sized_sm"
				title="show the file on disk, keeping your edit in the history"
				onclick={() => {
					editor_state.discard_draft();
					onresolve?.();
				}}
			>
				reload from disk
			</button>
		</div>
	</div>
{/if}

<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';

	const {
		editor_state,
		onresolve,
		attrs
	}: {
		editor_state: DiskfileEditorState;
		/** Called after the user overwrites or keeps the disk version, e.g. to refocus the editor. */
		onresolve?: (() => void) | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	let notice_el: HTMLDivElement | undefined = $state.raw();

	// what the user has besides the disk: their draft, or an older version they picked
	const yours = $derived(
		editor_state.selected_history_entry?.is_unsaved_edit ? 'your draft' : 'your version'
	);

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
<!-- TODO a "compare" diff view, once zzz has one — for now the disk version can be shown in place,
and both versions are in the history -->
{#if editor_state.has_conflict}
	<div {...attrs} role="alert" tabindex="-1" bind:this={notice_el}>
		<small class="color_c_60">
			{#if editor_state.showing_disk}
				showing the file on disk, read-only — {yours} is kept as it is, and saving stays paused
			{:else}
				changed on disk since you edited it — saving is paused so that change isn't overwritten;
				both versions are in the history
			{/if}
		</small>
		<div class="flex gap_xs mt_xs">
			<!-- a file deleted on disk has no disk version to show -->
			{#if !editor_state.diskfile.deleted_on_disk}
				<button
					type="button"
					class="sized_sm"
					disabled={editor_state.saving}
					title={editor_state.showing_disk
						? `show ${yours} again, editable`
						: `show the file on disk, read-only — ${yours} stays as it is`}
					onclick={() => editor_state.set_showing_disk(!editor_state.showing_disk)}
				>
					{editor_state.showing_disk ? `show ${yours}` : 'show disk version'}
				</button>
			{/if}
			<button
				type="button"
				class="sized_sm"
				disabled={editor_state.saving}
				title={editor_state.has_unsaved_edits
					? 'show your draft and save it over the file on disk'
					: `save ${editor_state.showing_disk ? 'your version' : 'the version shown'} over the file on disk`}
				onclick={async () => {
					// the draft, even if the editor shows an older entry or the disk (it's shown first)
					await editor_state.save_draft({ overwrite: true });
					onresolve?.();
				}}
			>
				{editor_state.has_unsaved_edits
					? 'overwrite with your draft'
					: editor_state.showing_disk
						? 'overwrite with your version'
						: 'overwrite with this version'}
			</button>
			<button
				type="button"
				class="sized_sm"
				title="keep the file on disk, setting your edit aside in the history"
				onclick={() => {
					editor_state.discard_draft();
					onresolve?.();
				}}
			>
				keep the disk version
			</button>
		</div>
	</div>
{/if}

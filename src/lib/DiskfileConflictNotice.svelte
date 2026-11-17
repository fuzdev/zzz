<script module lang="ts">
	import { tick } from 'svelte';

	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';

	/**
	 * Saves from a view (Ctrl+S, a save button), pointing at the conflict
	 * notice when the save is blocked — up front, or once the save's wait for
	 * the file's read (`DiskfileEditorState.save_changes`) uncovers a change on
	 * disk. A conflict found after the wait takes the focus only while the user
	 * hasn't moved on: focus where it was when the save started (or on
	 * `<body>`), and nothing typed since — so a keystroke made while the read
	 * waits is never taken away from the editor.
	 *
	 * @param editor_state - the file's editing state, which saves
	 * @param get_conflict_notice - the view's conflict notice, read when needed —
	 * after the wait, the one the view shows then
	 */
	export const save_from_view = async (
		editor_state: DiskfileEditorState,
		get_conflict_notice: () => { focus: () => boolean } | undefined
	): Promise<void> => {
		if (editor_state.has_conflict && get_conflict_notice()?.focus()) return;
		const focused_at_start = document.activeElement;
		const content_at_start = editor_state.current_content;
		const saved = await editor_state.save_changes();
		if (saved || !editor_state.has_conflict) return;
		const focused = document.activeElement;
		if (focused !== focused_at_start && focused !== document.body) return;
		if (editor_state.current_content !== content_at_start) return;
		// defensive: the notice has rendered by now in practice (Svelte flushes
		// in a microtask), but a tick costs nothing and covers a slower render
		await tick();
		get_conflict_notice()?.focus();
	};
</script>

<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';

	import ToggleButton from './ToggleButton.svelte';

	const {
		editor_state,
		onresolve,
		attrs
	}: {
		editor_state: DiskfileEditorState;
		/**
		 * Called after the user overwrites or keeps the disk version, e.g. to
		 * refocus the editor — not after an overwrite that leaves the conflict
		 * standing (refused, or failed): the notice takes the focus back then
		 * (its button, disabled while the save waited, lost it), unless the
		 * user moved it elsewhere meanwhile.
		 */
		onresolve?: (() => void) | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	let notice_el: HTMLDivElement | undefined = $state.raw();

	// what the user has besides the disk: their draft, or an older version they picked
	const yours = $derived(
		editor_state.selected_history_entry_id !== null &&
			editor_state.selected_history_entry_id === editor_state.unsaved_edit_entry_id
			? 'your draft'
			: 'your version'
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
				<!-- sized to its wider label, so toggling doesn't shift the buttons after it -->
				<ToggleButton
					bind:active={() => editor_state.showing_disk, (v) => editor_state.set_showing_disk(v)}
					inactive_content="show disk version"
					active_content="show {yours}"
					class="sized_sm"
					disabled={editor_state.saving || editor_state.save_pending}
					title={editor_state.showing_disk
						? `show ${yours} again, editable`
						: `show the file on disk, read-only — ${yours} stays as it is`}
				/>
			{/if}
			<button
				type="button"
				class="sized_sm"
				disabled={editor_state.saving || editor_state.save_pending || editor_state.dormant}
				title={editor_state.has_unsaved_edits
					? 'show your draft and save it over the file on disk'
					: `save ${editor_state.showing_disk ? 'your version' : 'the version shown'} over the file on disk`}
				onclick={async (event) => {
					const button = event.currentTarget;
					// the draft, even if the editor shows an older entry or the disk (it's shown first)
					const saved = await editor_state.save_draft({ overwrite: true });
					if (saved || !editor_state.has_conflict) {
						onresolve?.();
						return;
					}
					// refused — say a newer version landed — and the notice stays, with the
					// choice still to make. The button was disabled while the save waited,
					// which drops its focus to `<body>` in browsers: take it back to the
					// notice, unless the user has moved on
					const focused = document.activeElement;
					if (focused === button || focused === document.body || focused === null) focus();
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

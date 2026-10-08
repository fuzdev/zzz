<script lang="ts">
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import DialogContent from '@fuzdev/fuz_ui/DialogContent.svelte';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';
	import { untrack } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';

	// Asks about the draft when the last tab of a file with one closes, like
	// VS Code: save, don't save, or cancel (`DiskfilesEditor.request_close_tab`).
	// It goes away on its own when the draft does (saved or discarded elsewhere).

	const app = frontend_context.get();
	const { diskfiles } = app;
	const { editor } = diskfiles;

	const request = $derived(editor.pending_close_request);
	const tab = $derived(editor.pending_close_tab);
	const diskfile = $derived(tab?.diskfile);
	const editor_state = $derived(diskfile ? diskfiles.find_editor_state(diskfile.id) : undefined);

	// keyed to the tab, so a failure never carries over to another close
	let failure = $state.raw<{ tab_id: Uuid; message: string } | null>(null);
	const failure_message = $derived(failure && failure.tab_id === tab?.id ? failure.message : null);

	/** Focuses the editor of the selected tab — after a close, the next one. */
	const focus_selected_editor = (): void => {
		const diskfile_id = editor.tabs.selected_diskfile_id;
		if (diskfile_id) app.ui.pending_element_to_focus_key = diskfile_id;
	};

	// set when a choice handles focus itself, so the lapse handling below stays out
	let handled = false;

	const save = async (): Promise<void> => {
		if (!tab || !editor_state || !request) return;
		const tab_id = tab.id;
		// held across the save, which lapses the pending request once the draft is saved
		const this_request = request;
		failure = null;
		handled = true;
		// the draft, even if the editor shows an older entry
		const saved = await editor_state.save_draft();
		// cancelled (or dismissed) while the save was in flight — the tab stays
		if (this_request.cancelled) return;
		if (saved) {
			editor.close_tab(tab_id);
			focus_selected_editor();
			return;
		}
		handled = false;
		failure = {
			tab_id,
			message: editor_state.has_conflict
				? 'changed on disk since you edited it — overwrite or reload it in the editor first'
				: (editor_state.save_error ?? 'not saved')
		};
	};

	const dont_save = (): void => {
		if (!tab || !editor_state) return;
		const tab_id = tab.id;
		handled = true;
		editor_state.discard_draft();
		editor.close_tab(tab_id);
		focus_selected_editor();
	};

	// cancel and Escape leave focus to the native dialog, which restores it
	const cancel = (): void => {
		failure = null;
		handled = true;
		editor.cancel_close_tab();
	};

	// the question lapsed (its draft went away elsewhere) with the tab still
	// open and shown — focus its editor rather than leaving focus on `<body>`;
	// an unshown tab's editor isn't mounted, so a pending key would steal focus later
	$effect(() => {
		const asked = tab;
		if (!asked) return;
		handled = false;
		return () => {
			if (handled) return;
			untrack(() => {
				if (
					editor.tabs.items.by_id.has(asked.id) &&
					editor.tabs.selected_diskfile_id === asked.diskfile_id
				) {
					app.ui.pending_element_to_focus_key = asked.diskfile_id;
				}
			});
		};
	});
</script>

{#if tab && diskfile && editor_state}
	<Dialog onclose={cancel}>
		<DialogContent>
			<h2 class="mt_0">save changes to {diskfile.path_relative ?? diskfile.path}?</h2>
			<p>
				{#if diskfile.deleted_on_disk}
					It has unsaved edits and was deleted on disk. Saving recreates it; not saving discards the
					edits and forgets the file.
				{:else}
					It has unsaved edits. Not saving keeps them in the file's history as a discarded edit.
				{/if}
			</p>
			{#if failure_message !== null}
				<p class="color_c_60" role="alert">{failure_message}</p>
			{/if}
			<div class="display:flex gap_sm flex-wrap:wrap">
				<button
					type="button"
					class="palette_f"
					disabled={editor_state.saving}
					onclick={() => void save()}
				>
					save
				</button>
				<button type="button" onclick={dont_save}>don't save</button>
				<button type="button" onclick={cancel}>cancel</button>
			</div>
		</DialogContent>
	</Dialog>
{/if}

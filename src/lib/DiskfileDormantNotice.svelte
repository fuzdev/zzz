<script lang="ts">
	import { to_error_message } from '@fuzdev/fuz_util/error.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import { DISKFILE_DORMANT_LABEL, to_parent_path } from './diskfile_helpers.ts';

	/**
	 * Says a file is dormant (`DiskfileEditorState.dormant`: its project
	 * closed, so it can't be saved) and offers to reopen the project — the
	 * one holding the file's directory, as the daemon resolves it
	 * (`Projects.open`, the way `zzz <file>` does), which binds the file and
	 * its draft again. By the directory, since the file may be gone from
	 * disk, and the daemon opens a file's directory anyway. Its known files
	 * are reconciled with the reopened index, so one deleted while it was
	 * closed is flagged deleted — under the directories the reopen focuses.
	 *
	 * @module
	 */
	const {
		diskfile,
		small = false
	}: {
		diskfile: Diskfile;
		/** Sized for a file-part editor. */
		small?: boolean;
	} = $props();

	const app = frontend_context.get();

	let opening = $state.raw(false);
	let error: string | null = $state.raw(null);

	const reopen = async (): Promise<void> => {
		opening = true;
		error = null;
		try {
			const result = await app.projects.open(to_parent_path(diskfile.path), {
				reconcile_files: true
			});
			if (!result.ok) error = result.error.message;
		} catch (err) {
			error = to_error_message(err, 'reopening the project failed');
		} finally {
			opening = false;
		}
	};
</script>

<p class={small ? 'mb_xs text_50' : 'px_md py_xs text_50'}>
	<svelte:element this={small ? 'small' : 'span'}>
		{DISKFILE_DORMANT_LABEL} — it can't be saved until then
		<button
			type="button"
			class="inline sized_sm"
			disabled={opening}
			title="open the project holding this file again"
			onclick={() => void reopen()}
		>
			reopen project
		</button>
		{#if error !== null}
			<span class="color_c_60" role="alert">— {error}</span>
		{/if}
	</svelte:element>
</p>

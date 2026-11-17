<script lang="ts">
	import type { DiskfileStatus } from './diskfile_helpers.ts';

	/**
	 * A file's name in a row, then its markers: `(deleted)` for a file kept
	 * after it left disk, `(not indexed)` for one kept after it left the index
	 * (`Diskfile.uncovered`), `●` for unsaved changes (in the negative color when
	 * the file also changed on disk). Only the name truncates, so the markers
	 * always show. The markers are hidden from assistive tech — the row's
	 * accessible name says them (`to_diskfile_status_label`).
	 *
	 * @module
	 */
	const {
		label,
		status
	}: {
		label: string | null | undefined;
		status: DiskfileStatus;
	} = $props();
</script>

<span class="ml_xs ellipsis" class:deleted={status.deleted}>
	{label}
</span>
{#if status.deleted}
	<span class="ml_xs color_c_60" aria-hidden="true">(deleted)</span>
{:else if status.uncovered}
	<span class="ml_xs text_50" aria-hidden="true">(not indexed)</span>
{/if}
{#if status.dirty}
	<span class="ml_xs" class:color_c_50={status.conflict} aria-hidden="true">●</span>
{/if}

<style>
	.deleted {
		text-decoration: line-through;
	}
</style>

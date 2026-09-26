<script lang="ts">
	import type { DiskfilePart } from './part.svelte.ts';

	// says when a file part sends an unsaved draft instead of the file on disk
	const { part }: { part: DiskfilePart } = $props();

	const label = $derived(
		part.draft_status === 'conflict'
			? 'unsaved draft, changed on disk'
			: part.draft_status === 'deleted'
				? 'unsaved draft, deleted on disk'
				: part.draft_status === 'unsaved'
					? 'unsaved draft'
					: null
	);
</script>

{#if label}
	<small class="color_c_50" title="the prompt sends this unsaved draft, not the file on disk">
		({label})
	</small>
{/if}

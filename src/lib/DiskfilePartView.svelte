<script lang="ts">
	import { slide } from 'svelte/transition';
	import { resolve } from '$app/paths';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import PartSummary from './PartSummary.svelte';

	const {
		diskfile
	}: {
		diskfile: Diskfile;
	} = $props();

	const app = frontend_context.get();

	// a turn part in `app.parts` — shown without an owner, since several turns may share it
	const part = $derived(diskfile.part);

	// prompts own their part instances, so they're matched by path
	const referenced_by_prompts = $derived(app.prompts.filter_by_diskfile_path(diskfile.path));
</script>

{#if part || referenced_by_prompts.length}
	<div class="panel p_md" transition:slide>
		<h3 class="mt_0 mb_sm">Referenced by</h3>

		<div class="column gap_xs">
			<div class="part-reference">
				{#if part}
					<PartSummary {part} />
				{/if}

				{#if referenced_by_prompts.length}
					<div class="prompt-refs font_size_xs mt_xs2">
						<span class="text_50">In prompt{referenced_by_prompts.length !== 1 ? 's' : ''}:</span>
						{#each referenced_by_prompts as prompt (prompt.id)}
							<a href={resolve(`/prompts/${prompt.id}`)} class="prompt-ref">
								{prompt.name}
							</a>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.part-reference {
		padding: var(--space_xs2);
		background: var(--shade_20);
		border-radius: var(--border_radius_xs);
	}

	.prompt-refs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space_xs2);
		align-items: center;
	}

	.prompt-ref {
		padding: var(--space_xs3) var(--space_xs2);
		background: var(--shade_30);
		border-radius: var(--border_radius_xs);
		text-decoration: none;
		color: inherit;
	}

	.prompt-ref:hover {
		background: var(--shade_40);
	}
</style>

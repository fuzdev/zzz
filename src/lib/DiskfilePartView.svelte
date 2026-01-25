<script lang="ts">
	import {slide} from 'svelte/transition';
	import {resolve} from '$app/paths';

	import {frontend_context} from './frontend.svelte.js';
	import type {Diskfile} from './diskfile.svelte.js';
	import PartSummary from './PartSummary.svelte';

	const {
		diskfile,
	}: {
		diskfile: Diskfile;
	} = $props();

	const app = frontend_context.get();

	const part = $derived(diskfile.part);

	const referenced_by_prompts = $derived(part ? app.prompts.filter_by_part(part) : null);
</script>

{#if part}
	<div class="panel p_md" transition:slide>
		<h3 class="mt_0 mb_sm">Referenced by part</h3>

		<div class="column gap_xs">
			<div class="part_reference">
				<PartSummary {part} />

				{#if referenced_by_prompts?.length}
					<div class="prompt_refs font_size_xs mt_xs2">
						<span class="text_50">In prompt{referenced_by_prompts.length !== 1 ? 's' : ''}:</span>
						{#each referenced_by_prompts as prompt (prompt.id)}
							<a href={resolve(`/prompts/${prompt.id}`)} class="prompt_ref">
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
	.part_reference {
		padding: var(--space_xs2);
		background: var(--shade_20);
		border-radius: var(--border_radius_xs);
	}

	.prompt_refs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space_xs2);
		align-items: center;
	}

	.prompt_ref {
		padding: var(--space_xs3) var(--space_xs2);
		background: var(--shade_30);
		border-radius: var(--border_radius_xs);
		text-decoration: none;
		color: inherit;
	}

	.prompt_ref:hover {
		background: var(--shade_40);
	}
</style>

<script lang="ts">
	import {slide} from 'svelte/transition';
	import {resolve} from '$app/paths';

	import NavLink from '$lib/NavLink.svelte';
	import {projects_context} from '$routes/projects/projects.svelte.js';
	import {GLYPH_ADD} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';

	const projects = projects_context.get();

	const project_viewmodel = $derived(projects.current_project_viewmodel);
</script>

<aside class="height:100% overflow-y:auto unstyled width_atmost_xs p_xs">
	{#if project_viewmodel}
		<div class="display:flex">
			<button
				type="button"
				class="plain justify-content:start flex:1"
				onclick={() => project_viewmodel.create_new_domain()}
			>
				<Glyph glyph={GLYPH_ADD} />&nbsp; new domain
			</button>
		</div>

		<nav>
			<ul class="unstyled">
				{#if project_viewmodel.project}
					{#each project_viewmodel.project.domains as domain (domain.id)}
						<li transition:slide>
							<NavLink
								href={resolve(`/projects/${project_viewmodel.project_id}/domains/${domain.id}`)}
								selected={domain.id === projects.current_domain_id}
								title={domain.name}
							>
								<div class="ellipsis row flex:1 pr_xs">{domain.name || '[new domain]'}</div>
								<span
									class="status_dot {domain.status === 'active'
										? 'status_active'
										: domain.status === 'pending'
											? 'status_pending'
											: 'status_inactive'}"
								></span>
							</NavLink>
						</li>
					{/each}
				{/if}
			</ul>
		</nav>
	{/if}
</aside>

<style>
	.status_dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status_active {
		background-color: var(--color_a_50);
	}

	.status_pending {
		background-color: var(--color_e_50);
	}

	.status_inactive {
		background-color: var(--text_50);
	}
</style>

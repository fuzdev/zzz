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
				onclick={() => project_viewmodel.create_new_page()}
			>
				<Glyph glyph={GLYPH_ADD} />&nbsp; new page
			</button>
		</div>

		<nav>
			<ul class="unstyled">
				{#if project_viewmodel.project}
					{#each project_viewmodel.project.pages as page (page.id)}
						<li transition:slide>
							<NavLink
								href={resolve(`/projects/${project_viewmodel.project_id}/pages/${page.id}`)}
								selected={page.id === projects.current_page_id}
								title={page.title}
							>
								<span class="ellipsis">{page.title}</span>
							</NavLink>
						</li>
					{/each}
				{/if}
			</ul>
		</nav>
	{/if}
</aside>

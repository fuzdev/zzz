<script lang="ts">
	import {slide} from 'svelte/transition';
	import {goto} from '$app/navigation';
	import {resolve} from '$app/paths';

	import NavLink from '$lib/NavLink.svelte';
	import {projects_context} from '$routes/projects/projects.svelte.js';
	import {GLYPH_ADD} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';

	const projects = projects_context.get();
</script>

<aside class="height:100% overflow-y:auto unstyled width_upto_xs p_xs">
	<div class="display:flex">
		<button
			type="button"
			class="plain justify-content:start flex:1"
			onclick={() => {
				const project = projects.create_new_project();
				void goto(resolve(`/projects/${project.id}`));
			}}
		>
			<Glyph glyph={GLYPH_ADD} />&nbsp; new project
		</button>
	</div>

	<nav>
		<ul class="unstyled">
			{#each projects.projects as project (project.id)}
				<li transition:slide>
					<NavLink
						href={resolve(`/projects/${project.id}`)}
						selected={project.id === projects.current_project_id}
						title={project.name}
					>
						<span class="ellipsis">{project.name}</span>
					</NavLink>
				</li>
			{/each}
		</ul>
	</nav>

	<aside title="huh I might take quality vibecoded PRs, but probably in a new repo">
		⚠️ <small>speculative demo</small> ⚠️
	</aside>
</aside>

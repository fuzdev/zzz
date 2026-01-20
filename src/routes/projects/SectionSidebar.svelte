<script lang="ts">
	import {resolve} from '$app/paths';

	import NavLink from '$lib/NavLink.svelte';
	import type {Project, ProjectSection} from '$routes/projects/project.svelte.js';

	const {
		project,
		section,
	}: {
		project: Project;
		section: ProjectSection;
	} = $props();

	// TODO what else should be here? deployments?
	// is `pages` the wrong way to think about it?
	// what about data?
</script>

<aside class="overflow-y:auto unstyled width_atmost_xs p_xs">
	<nav>
		<ul class="unstyled">
			<li>
				<NavLink
					href={resolve(`/projects/${project.id}`)}
					selected={section === 'project'}
					show_selected_descendent={false}
				>
					project
				</NavLink>
			</li>
			<li>
				<NavLink href={resolve(`/projects/${project.id}/pages`)} selected={section === 'pages'}
					>pages</NavLink
				>
			</li>
			<li>
				<NavLink href={resolve(`/projects/${project.id}/domains`)} selected={section === 'domains'}>
					domains
				</NavLink>
			</li>
			<li>
				<NavLink href={resolve(`/projects/${project.id}/repos`)} selected={section === 'repos'}>
					repos
				</NavLink>
			</li>
			<li>
				<NavLink
					href={resolve(`/projects/${project.id}/settings`)}
					selected={section === 'settings'}
				>
					settings
				</NavLink>
			</li>
		</ul>
	</nav>
</aside>

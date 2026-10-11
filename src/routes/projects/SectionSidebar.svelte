<script lang="ts">
	import { resolve } from '$app/paths';

	import NavLink from '#lib/NavLink.svelte';
	import type { Project, ProjectSection } from './project.svelte.ts';

	const {
		project,
		section
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
					href={resolve('/projects/[project_id]', { project_id: project.id })}
					selected={section === 'project'}
					show_selected_descendent={false}
				>
					project
				</NavLink>
			</li>
			<li>
				<NavLink
					href={resolve('/projects/[project_id]/pages', { project_id: project.id })}
					selected={section === 'pages'}
				>
					pages
				</NavLink>
			</li>
			<li>
				<NavLink
					href={resolve('/projects/[project_id]/domains', { project_id: project.id })}
					selected={section === 'domains'}
				>
					domains
				</NavLink>
			</li>
			<li>
				<NavLink
					href={resolve('/projects/[project_id]/repos', { project_id: project.id })}
					selected={section === 'repos'}
				>
					repos
				</NavLink>
			</li>
			<li>
				<NavLink
					href={resolve('/projects/[project_id]/settings', { project_id: project.id })}
					selected={section === 'settings'}
				>
					settings
				</NavLink>
			</li>
		</ul>
	</nav>
</aside>

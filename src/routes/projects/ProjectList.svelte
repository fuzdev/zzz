<script lang="ts">
	import {resolve} from '$app/paths';

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import Glyph from '$lib/Glyph.svelte';
	import {GLYPH_ADD} from '$lib/glyphs.js';

	const projects = projects_context.get();
</script>

<section class="project_list">
	<h2 class="mt_0 mb_lg">Projects</h2>

	{#if projects.projects.length === 0}
		<div class="panel p_lg width_atmost_md">
			<p>no projects yet</p>
		</div>
	{:else}
		<div class="projects_grid">
			{#each projects.projects as project (project.id)}
				<a
					href={resolve(`/projects/${project.id}`)}
					class="project_card panel p_md font-weight:400"
				>
					<h3 class="mt_0 mb_sm">{project.name}</h3>
					<p class="mb_md">{project.description}</p>
					<div class="domains_list mb_md">
						{#each project.domains as domain (domain.id)}
							<div class="domain_chip">
								<span
									class="status_dot {domain.status === 'active'
										? 'status_active'
										: domain.status === 'pending'
											? 'status_pending'
											: 'status_inactive'}"
								></span>
								{domain.name}
								{#if !domain.ssl}
									<span class="no_ssl_badge">no SSL</span>
								{/if}
							</div>
						{/each}
					</div>
					<div class="display:flex gap_md">
						<small class="chip"
							>{project.pages.length} {project.pages.length === 1 ? 'page' : 'pages'}</small
						>
						<small class="chip">updated {new Date(project.updated).toLocaleDateString()}</small>
					</div>
				</a>
			{/each}
		</div>
	{/if}

	<div class="display:flex justify_content_between mt_lg">
		<button type="button" class="color_a" onclick={() => projects.create_new_project()}>
			<Glyph glyph={GLYPH_ADD} />&nbsp; new project
		</button>
	</div>
</section>

<style>
	.projects_grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--font_size_md);
	}

	.project_card {
		display: block;
		text-decoration: none;
		color: inherit;
		border: 1px solid var(--border_color_10);
	}

	.project_card:hover {
		border-color: var(--border_color_20);
	}

	.domains_list {
		display: flex;
		flex-direction: column;
		gap: var(--font_size_xs);
	}

	.domain_chip {
		display: inline-flex;
		align-items: center;
		gap: var(--font_size_xs);
		font-family: var(--font_family_mono);
	}

	.status_dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.status_active {
		background-color: var(--color_b_50);
	}

	.status_pending {
		background-color: var(--color_e_50);
	}

	.status_inactive {
		background-color: var(--text_50);
	}

	.no_ssl_badge {
		font-size: 0.8em;
		background-color: var(--shade_20);
		padding: 1px 4px;
		border-radius: var(--border_radius_xs);
	}
</style>

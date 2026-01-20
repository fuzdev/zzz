<script lang="ts">
	// @slop Claude Opus 4

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import ReposSidebar from '$routes/projects/ReposSidebar.svelte';
	import {GLYPH_ADD} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import RepoTableRow from '$routes/projects/RepoTableRow.svelte';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';

	const projects = projects_context.get();

	const project_viewmodel = $derived(projects.current_project_viewmodel);
	const project = $derived(projects.current_project);
</script>

<div class="project_layout">
	<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
	<ProjectSidebar />
	{#if project}
		<SectionSidebar {project} section="repos" />
		<ReposSidebar />
	{/if}

	<div class="project_content">
		{#if project_viewmodel?.project}
			<div class="p_lg">
				<h1 class="mb_lg">repos</h1>

				{#if project_viewmodel.project.repos.length === 0}
					<div class="panel p_lg text-align:center mb_lg">
						<p>this project has no repositories configured yet</p>
						<p>
							<button
								type="button"
								class="color_a"
								onclick={() => project_viewmodel.create_new_repo()}
							>
								<Glyph glyph={GLYPH_ADD} />&nbsp; add your first repo
							</button>
						</p>
					</div>
				{:else}
					<table class="width:100%">
						<thead>
							<tr>
								<th>repo</th>
								<th>checkouts</th>
								<th>created</th>
								<th>updated</th>
							</tr>
						</thead>
						<tbody>
							{#each project_viewmodel.project.repos as repo (repo.id)}
								<RepoTableRow {repo} project_id={project_viewmodel.project_id} />
							{/each}
						</tbody>
					</table>
				{/if}

				<div>
					<button type="button" class="color_a" onclick={() => project_viewmodel.create_new_repo()}>
						<Glyph glyph={GLYPH_ADD} />&nbsp; new repo
					</button>
				</div>
			</div>
		{:else}
			<ProjectNotFound />
		{/if}
	</div>
</div>

<style>
	.project_layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.project_content {
		flex: 1;
		overflow: auto;
	}
</style>

<script lang="ts">
	// @slop Claude Opus 4

	import {resolve} from '$app/paths';

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import PagesSidebar from '$routes/projects/PagesSidebar.svelte';
	import Glyph from '$lib/Glyph.svelte';
	import {GLYPH_ADD} from '$lib/glyphs.js';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';

	const projects = projects_context.get();

	const project_viewmodel = $derived(projects.current_project_viewmodel);

	const page_count = $derived(project_viewmodel?.project?.pages.length);
</script>

<div class="project_layout">
	<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
	<ProjectSidebar />
	{#if projects.current_project}
		<SectionSidebar project={projects.current_project} section="pages" />
		<PagesSidebar />
	{/if}

	<div class="project_content">
		{#if project_viewmodel?.project}
			<div class="p_lg">
				<h1 class="mb_lg">pages</h1>

				{#if !page_count}
					<p>this project has no web pages yet</p>
					<p>
						<button
							type="button"
							class="color_a"
							onclick={() => project_viewmodel.create_new_page()}
						>
							<Glyph glyph={GLYPH_ADD} />&nbsp; create your first page
						</button>
					</p>
				{:else}
					<table class="width:100%">
						<thead>
							<tr>
								<th>title</th>
								<th>path</th>
								<th>created</th>
								<th>updated</th>
							</tr>
						</thead>
						<tbody>
							{#each project_viewmodel.project.pages as page (page.id)}
								<tr>
									<td>
										<a href={resolve(`/projects/${project_viewmodel.project_id}/pages/${page.id}`)}
											>{page.title}</a
										>
									</td>
									<td>{page.path}</td>
									<td>{new Date(page.created).toLocaleString()}</td>
									<td>{new Date(page.updated).toLocaleString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>

					<div class="mb_lg">
						<button
							type="button"
							class="color_a"
							onclick={() => project_viewmodel.create_new_page()}
						>
							<Glyph glyph={GLYPH_ADD} />&nbsp; new page
						</button>
					</div>
				{/if}
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

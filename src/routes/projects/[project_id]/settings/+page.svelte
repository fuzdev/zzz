<script lang="ts">
	// @slop Claude Opus 4

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';
	import {GLYPH_DELETE} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';

	const projects = projects_context.get();

	const project_viewmodel = $derived(projects.current_project_viewmodel);

	const project = $derived(projects.current_project);
</script>

<div class="project_layout">
	<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
	<ProjectSidebar />
	{#if project}
		<SectionSidebar {project} section="settings" />
	{/if}

	<div class="project_content">
		{#if project_viewmodel?.project}
			<div class="p_lg">
				<h1 class="mb_lg">project settings</h1>

				<div class="panel p_md width_upto_md my_lg">
					<div class="mb_md">
						<label>
							<div class="title">project name</div>
							<input
								type="text"
								bind:value={project_viewmodel.edited_name}
								class="width:100%"
								placeholder={project_viewmodel.project.name}
							/>
						</label>
					</div>

					<div class="mb_md">
						<label>
							<div class="title">description</div>
							<textarea
								bind:value={project_viewmodel.edited_description}
								class="width:100%"
								rows="3"
								placeholder={project_viewmodel.project.description || 'No description'}
							></textarea>
						</label>
					</div>

					<button
						type="button"
						onclick={() => project_viewmodel.save_project_details()}
						class="color_a"
						disabled={!project_viewmodel.has_changes}
					>
						save changes
					</button>
				</div>

				<div class="panel p_md width_upto_md">
					<h2 class="mt_0 mb_lg">danger zone</h2>
					<p class="mb_md">These actions cannot be undone.</p>

					<button
						type="button"
						class="color_c"
						onclick={() => project_viewmodel.delete_current_project()}
					>
						<Glyph glyph={GLYPH_DELETE} />&nbsp; delete project
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

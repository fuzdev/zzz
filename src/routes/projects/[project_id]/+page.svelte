<script lang="ts">
	// @slop Claude Opus 4

	import {resolve} from '$app/paths';

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';

	const projects = projects_context.get();

	const project_viewmodel = $derived(projects.current_project_viewmodel);

	const project = $derived(projects.current_project);
</script>

<div class="project-layout">
	<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
	<ProjectSidebar />
	{#if project}
		<SectionSidebar {project} section="project" />
	{/if}

	<div class="project-content">
		{#if project && project_viewmodel}
			<div class="p_lg">
				<h1 class="mb_0">{project.name}</h1>
				<div>
					{#if project_viewmodel.editing_project}
						<div class="display:flex gap_sm mb_sm">
							<button
								type="button"
								class="color_a"
								onclick={() => project_viewmodel.save_project_details()}
								disabled={!project_viewmodel.has_changes}>save</button
							>
							<button
								type="button"
								class="plain"
								onclick={() => {
									project_viewmodel.editing_project = false;
									project_viewmodel.reset_form();
								}}>cancel</button
							>
						</div>
					{:else}
						<button
							type="button"
							class="plain"
							onclick={() => (project_viewmodel.editing_project = true)}>edit</button
						>
					{/if}
				</div>

				{#if project_viewmodel.editing_project}
					<div class="panel p_md width_atmost_md mb_lg">
						<div class="mb_md">
							<label>
								project name
								<input type="text" bind:value={project_viewmodel.edited_name} class="width:100%" />
							</label>
						</div>
						<div>
							<label>
								description
								<textarea
									bind:value={project_viewmodel.edited_description}
									class="width:100%"
									rows="3"
								></textarea>
							</label>
						</div>
					</div>
				{:else if project.description}
					<p class="mb_lg width_atmost_md">{project.description}</p>
				{/if}

				<div class="display:flex gap_md mb_lg">
					<span class="chip"
						>{project.pages.length}
						{project.pages.length === 1 ? 'page' : 'pages'}</span
					>
					<span class="chip"
						>{project.domains.length}
						{project.domains.length === 1 ? 'domain' : 'domains'}</span
					>
					<span class="chip"
						>{project.repos.length}
						{project.repos.length === 1 ? 'repo' : 'repos'}</span
					>
					<span class="chip">created {new Date(project.created).toLocaleDateString()}</span>
					<span class="chip">updated {new Date(project.updated).toLocaleDateString()}</span>
				</div>

				<div class="projects-grid">
					<div class="panel p_md">
						<h2 class="mt_0 mb_lg">
							<a href={resolve(`/projects/${project.id}/pages`)}>pages</a>
						</h2>
						{#if project.pages.length === 0}
							<p class="text_50">no pages created yet</p>
						{:else}
							<ul class="pages-list">
								{#each project.pages as page (page.id)}
									<li>
										<a href={resolve(`/projects/${project.id}/pages/${page.id}`)}>{page.title}</a>
										<span class="text_50">{page.path}</span>
									</li>
								{/each}
							</ul>
						{/if}
						<div class="mt_md">
							<button
								type="button"
								onclick={() => project_viewmodel.create_new_page()}
								class="color_a">+ add page</button
							>
						</div>
					</div>

					<div class="panel p_md">
						<h2 class="mt_0 mb_lg">
							<a href={resolve(`/projects/${project.id}/domains`)}>domains</a>
						</h2>
						{#if project.domains.length === 0}
							<p class="text_50">no domains configured yet</p>
						{:else}
							<ul class="domains-list">
								{#each project.domains as domain (domain.id)}
									<li>
										<a href={resolve(`/projects/${project.id}/domains/${domain.id}`)}>
											<span class="domain-name">{domain.name}</span>
										</a>
										<div class="domain-details">
											<span
												class="status-badge {domain.status === 'active'
													? 'status-active'
													: domain.status === 'pending'
														? 'status-pending'
														: 'status-inactive'}"
											>
												{domain.status}
											</span>
											{#if domain.ssl}
												<span class="ssl-badge">SSL</span>
											{/if}
										</div>
									</li>
								{/each}
							</ul>
						{/if}
						<div class="mt_md">
							<button
								type="button"
								onclick={() => project_viewmodel.create_new_domain()}
								class="color_a">+ add domain</button
							>
						</div>
					</div>

					<div class="panel p_md">
						<h2 class="mt_0 mb_lg">
							<a href={resolve(`/projects/${project.id}/repos`)}>repos</a>
						</h2>
						{#if project.repos.length === 0}
							<p class="text_50">no repos configured yet</p>
						{:else}
							<ul class="repos-list">
								{#each project.repos as repo (repo.id)}
									<li>
										<a href={resolve(`/projects/${project.id}/repos/${repo.id}`)}>
											<span class="repo-url">{repo.git_url || '[new repo]'}</span>
										</a>
										<div class="repo-details">
											<span class="checkout-badge">
												{repo.checkouts.length}
												checkout dir{repo.checkouts.length === 1 ? '' : 's'}
											</span>
										</div>
									</li>
								{/each}
							</ul>
						{/if}
						<div class="mt_md">
							<button
								type="button"
								onclick={() => project_viewmodel.create_new_repo()}
								class="color_a">+ add repo</button
							>
						</div>
					</div>
				</div>
			</div>
		{:else}
			<ProjectNotFound />
		{/if}
	</div>
</div>

<style>
	.project-layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.project-content {
		flex: 1;
		overflow: auto;
	}

	.projects-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--font_size_md);
	}

	.pages-list,
	.domains-list,
	.repos-list {
		list-style: none;
		padding: 0;
		margin: var(--font_size_md) 0;
	}

	.pages-list li,
	.domains-list li,
	.repos-list li {
		padding: var(--font_size_xs) 0;
		border-bottom: 1px solid var(--border_color_10);
		display: flex;
		flex-direction: column;
	}

	.domain-name,
	.repo-url {
		font-family: var(--font_family_mono);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.domain-details,
	.repo-details {
		display: flex;
		gap: var(--font_size_xs);
		margin-top: 4px;
	}

	.status-badge,
	.checkout-badge {
		display: inline-block;
		padding: 2px 6px;
		border-radius: 10px;
		font-size: 0.75em;
	}

	.checkout-badge {
		background-color: var(--shade_20);
		color: var(--text_50);
	}

	.ssl-badge {
		display: inline-block;
		padding: 2px 6px;
		border-radius: 10px;
		font-size: 0.75em;
		background-color: var(--shade_20);
	}

	.status-active {
		background-color: var(--color_b_20);
		color: var(--color_b_90);
	}

	.status-pending {
		background-color: var(--color_e_20);
		color: var(--color_e_90);
	}

	.status-inactive {
		background-color: var(--shade_20);
		color: var(--text_50);
	}
</style>

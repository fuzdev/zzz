<script lang="ts">
	// @slop Claude Opus 4

	import {swallow} from '@fuzdev/fuz_util/dom.js';

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import ReposSidebar from '$routes/projects/ReposSidebar.svelte';
	import {GLYPH_DELETE, GLYPH_ADD} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';
	import RepoCheckoutItem from '$routes/projects/RepoCheckoutItem.svelte';

	const projects = projects_context.get();

	const repos_viewmodel = $derived(projects.current_repos_viewmodel);

	const add_tag = (dir_index: number, tag: string) => {
		if (!repos_viewmodel || !tag.trim()) return;
		const checkout_dir = repos_viewmodel.checkouts[dir_index];
		if (checkout_dir && !checkout_dir.tags.includes(tag)) {
			checkout_dir.tags.push(tag);
		}
	};

	const remove_tag = (dir_index: number, tag_index: number) => {
		if (!repos_viewmodel) return;
		const checkout_dir = repos_viewmodel.checkouts[dir_index];
		if (checkout_dir) {
			checkout_dir.tags.splice(tag_index, 1);
		}
	};

	const project = $derived(projects.current_project);
</script>

<div class="repo_layout">
	<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
	<ProjectSidebar />
	{#if project}
		<SectionSidebar {project} section="repos" />
		<ReposSidebar />
	{/if}

	<div class="repo_content">
		{#if project && repos_viewmodel}
			<div class="p_lg">
				<h1 class="mb_lg">edit repo</h1>

				<div class="panel p_md width_upto_md">
					<form
						onsubmit={(e) => {
							swallow(e);
							repos_viewmodel.save_repo_settings();
						}}
					>
						<div class="mb_lg">
							<label>
								<h3 class="mt_0 mb_sm">Git url</h3>
								<input type="text" bind:value={repos_viewmodel.git_url} class="width:100%" />
							</label>
							<p>
								enter the git URL, e.g. https://github.com/username/repo or
								git@github.com:username/repo.git
							</p>
						</div>

						{#if repos_viewmodel.repo}
							<p>
								<small>created {new Date(repos_viewmodel.repo.created).toLocaleString()}</small>
								<br />
								<small>updated {new Date(repos_viewmodel.repo.updated).toLocaleString()}</small>
							</p>
						{/if}

						<div class="mb_lg">
							<h3 class="mt_0 mb_sm">checkouts</h3>

							{#if repos_viewmodel.checkouts.length === 0}
								<p class="mb_md">no checkouts yet</p>
							{:else}
								{#each repos_viewmodel.checkouts as checkout, i (checkout.id)}
									<RepoCheckoutItem
										{checkout}
										index={i}
										on_remove={(index) => repos_viewmodel.remove_checkout_dir(index)}
										on_add_tag={add_tag}
										on_remove_tag={remove_tag}
									/>
								{/each}
							{/if}

							<div class="mt_md">
								<button
									type="button"
									class="color_b"
									onclick={() => repos_viewmodel.add_checkout_dir()}
								>
									<Glyph glyph={GLYPH_ADD} />&nbsp; add checkout
								</button>
							</div>
						</div>

						<div class="width:100% display:flex justify-content:space-between gap_sm">
							<div>
								<button
									type="submit"
									class="color_a"
									disabled={repos_viewmodel.repo && !repos_viewmodel.has_changes}
								>
									{repos_viewmodel.repo ? 'save changes' : 'add repo'}
								</button>
							</div>

							{#if repos_viewmodel.repo}
								<button type="button" class="color_c" onclick={() => repos_viewmodel.remove_repo()}>
									<Glyph glyph={GLYPH_DELETE} />&nbsp; delete repo
								</button>
							{/if}
						</div>
					</form>
				</div>
			</div>
		{:else}
			<ProjectNotFound />
		{/if}
	</div>
</div>

<style>
	.repo_layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.repo_content {
		flex: 1;
		overflow: auto;
	}
</style>

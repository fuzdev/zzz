<script lang="ts">
	// @slop Claude Opus 4

	import {goto} from '$app/navigation';
	import {resolve} from '$app/paths';
	import Mdz from '@fuzdev/fuz_ui/Mdz.svelte';

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import PagesSidebar from '$routes/projects/PagesSidebar.svelte';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';
	import {GLYPH_DELETE, GLYPH_PREVIEW, GLYPH_PLACEHOLDER} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import {frontend_context} from '$lib/frontend.svelte.js';

	const projects = projects_context.get();
	const app = frontend_context.get();

	const page_viewmodel = $derived(projects.current_page_viewmodel);

	// Preview mode state
	let preview_mode = $state(false);

	// Toggle preview mode
	const toggle_preview = () => {
		preview_mode = !preview_mode;
	};

	// TODO refactor with proper state/API
	/** Delete the current page and navigate back to pages list. */
	const delete_page = () => {
		const controller = projects.current_project_viewmodel;
		if (!page_viewmodel?.project || !page_viewmodel.current_page || !controller) {
			return;
		}

		// eslint-disable-next-line no-alert
		if (confirm('Are you sure you want to delete this page? This action cannot be undone.')) {
			controller.delete_project_page(page_viewmodel.page_id);

			// Navigate back to pages list
			void goto(resolve(`/projects/${page_viewmodel.project_id}/pages`));
		}
	};

	const project = $derived(projects.current_project);
</script>

{#if preview_mode}
	<div class="preview_fullscreen" class:offset_for_sidebar={app.ui.show_sidebar}>
		<div class="markdown_preview p_lg">
			<Mdz content={page_viewmodel?.content ?? ''} />
		</div>

		<!-- preview toggle button in top-right corner -->
		<button
			type="button"
			class="position:fixed top:0 right:0 icon_button plain border_radius_0"
			aria-label="close preview"
			title="close preview"
			onclick={toggle_preview}
		>
			<Glyph glyph={GLYPH_PREVIEW} />
		</button>
	</div>
{:else}
	<div class="editor_layout">
		<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
		<ProjectSidebar />
		{#if project}
			<SectionSidebar {project} section="pages" />
			<PagesSidebar />
		{/if}

		<div class="editor_content">
			{#if page_viewmodel && project}
				<div class="height:100% column p_lg">
					<div>
						<div class="display:flex gap_sm align-items:center">
							<h1 class="mb_lg">
								{page_viewmodel.current_page?.title || 'Page'}
							</h1>
						</div>

						<div class="display:flex width:100% justify-content:space-between gap_sm mb_lg">
							<div class="display:flex gap_sm">
								<button
									type="button"
									onclick={() => page_viewmodel.save_page()}
									class="color_a"
									disabled={!page_viewmodel.has_changes}
								>
									save
								</button>

								<button type="button" onclick={toggle_preview} class="plain" title="Preview page">
									<Glyph glyph={GLYPH_PREVIEW} />&nbsp; preview
								</button>
							</div>

							<button type="button" onclick={delete_page} class="color_c"
								><Glyph glyph={GLYPH_DELETE} />&nbsp; delete</button
							>
						</div>
					</div>

					<div class="panel p_md mb_md">
						<div class="display:flex gap_sm">
							<div class="flex:1">
								<label>
									page title
									<input
										type="text"
										bind:value={page_viewmodel.title}
										class="width:100%"
										placeholder="page title"
									/>
								</label>
							</div>
							<div class="flex:1">
								<label>
									page path
									<input
										type="text"
										bind:value={page_viewmodel.path}
										class="width:100%"
										placeholder="/page-path"
									/>
								</label>
							</div>
						</div>
					</div>

					<div class="editor_area">
						<div class="panel p_md content_area">
							<textarea
								bind:value={page_viewmodel.content}
								class="width:100% height:100% markdown_editor"
								placeholder="{GLYPH_PLACEHOLDER} markup"
							></textarea>
						</div>

						<div class="panel p_md preview_area">
							<div class="markdown_preview"><Mdz content={page_viewmodel.content} /></div>
						</div>
					</div>
				</div>
			{:else}
				<ProjectNotFound />
			{/if}
		</div>
	</div>
{/if}

<style>
	.editor_layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.editor_content {
		height: 100%;
		flex: 1;
		overflow: auto;
	}

	.editor_area {
		display: flex;
		gap: var(--font_size_md);
		flex: 1;
	}

	.content_area,
	.preview_area {
		width: 50%;
		overflow: auto;
	}

	.markdown_editor {
		width: 100%;
		height: 100%;
		resize: none;
		border: none;
		background: transparent;
		font-family: var(--font_family_mono);
		font-size: 1em;
		line-height: 1.5;
		padding: var(--font_size_xs);
		outline: none;
	}

	.markdown_preview {
		padding: var(--font_size_xs);
	}

	.preview_fullscreen {
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: var(--shade_00);
		z-index: 1000;
		overflow: auto;
	}
	.preview_fullscreen.offset_for_sidebar {
		padding-left: var(--sidebar_width);
	}
</style>

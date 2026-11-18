<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { frontend_context } from '#lib/frontend.svelte.ts';
	import type { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
	import type { Project } from '#lib/project.svelte.ts';
	import {
		format_project_fallback,
		format_project_opened,
		parse_project_path,
		PROJECT_DEGRADED_NOTICE
	} from '#lib/project_helpers.ts';
	import { icon_add, icon_delete, icon_directory, icon_project } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from '#lib/Icon.svelte';
	import ProjectRegistryEntries from '#lib/ProjectRegistryEntries.svelte';
	import PageFooter from '#routes/PageFooter.svelte';

	const app = frontend_context.get();

	let new_path = $state.raw('');
	let opening = $state.raw(false);
	let error_message: string | null = $state.raw(null);
	/** Where the last open from this page landed and why. */
	let opened_message: string | null = $state.raw(null);

	const KIND_LABELS: Record<Project['kind'], string> = {
		registry: 'registry',
		git_repo: 'git repo',
		plain_dir: 'directory'
	};

	/**
	 * Open what `path` names, as the form and the `?open=` param both do (the
	 * `path_open` intent), saying where it landed and why.
	 *
	 * @returns an error message, or `null` on success
	 */
	const open_path = async (path: DiskfilePath): Promise<string | null> => {
		opened_message = null;
		const result = await app.intents.path_open({ path });
		if (!result.ok) return result.error.message;
		const { root } = result.value;
		// `null` when it's closed already — a close this client applied after the open landed
		const project = root ? app.projects.get_by_root(root) : undefined;
		if (project) opened_message = format_project_opened(path, project);
		return null;
	};

	// Open the path in the `?open=` param (e.g. from `zzz <path>`): its
	// project, and a file in a tab
	const open_param = $derived(page.url.searchParams.get('open'));

	// Non-reactive: each param value is handled once, then stripped from the URL.
	// Reset when the param clears so navigating to the same value again reopens.
	let last_handled_param: string | null = null;

	$effect(() => {
		const param = open_param;
		if (param === null) {
			last_handled_param = null;
			return;
		}
		// after the session loads: `~` expands to the daemon's home from it
		if (app.session_status !== 'success') return;
		if (param === last_handled_param) return;
		last_handled_param = param;
		// untracked so project collection changes (a close, another open)
		// never re-run this — which would reopen a just-closed project or
		// steal the user's selection
		untrack(() => void handle_open_param(param));
	});

	const handle_open_param = async (param: string): Promise<void> => {
		// strip first so a reload never re-opens a project the user has since
		// closed; the open waits out the strip before going on to `/files`
		// (`Projects.open_path`), so it can't leave the param in history under it
		void goto(resolve('/projects'), { replace: true, reset: false });

		const parsed = parse_project_path(param, app.home_dir);
		if (!parsed.ok) {
			error_message = `can't open from URL: ${parsed.message}`;
			return;
		}
		const error = await open_path(parsed.path);
		if (error !== null) error_message = error;
	};

	const handle_open = async (): Promise<void> => {
		if (opening) return;
		const raw = new_path.trim();
		if (!raw) return;

		error_message = null;
		const parsed = parse_project_path(raw, app.home_dir);
		if (!parsed.ok) {
			error_message = parsed.message;
			return;
		}

		opening = true;
		try {
			const error = await open_path(parsed.path);
			if (error === null) {
				new_path = '';
			} else {
				error_message = error;
			}
		} finally {
			opening = false;
		}
	};

	const handle_close = async (root: DiskfileDirectoryPath): Promise<void> => {
		error_message = null;
		const result = await app.close_project(root);
		if (!result.ok) error_message = `failed to close ${root}: ${result.error.message}`;
	};

	/** Focuses or unfocuses a registry entry of `project`, saying why when it can't. */
	const toggle_focus = async (project: Project, dir: DiskfileDirectoryPath): Promise<void> => {
		error_message = null;
		const unfocus = project.focused.includes(dir);
		const result = unfocus ? await project.unfocus_repo(dir) : await project.focus_repo(dir);
		if (!result.ok) {
			error_message = `failed to ${unfocus ? 'unfocus' : 'focus'} ${dir}: ${result.error.message}`;
		}
	};
</script>

<div class="projects_page p_xl">
	<header class="mb_xl">
		<h1><Icon data={icon_project} /> Projects</h1>
		<p class="text_50">
			Open a file or directory to open its project — and a file in a tab: a trusted
			<code>repos.toml</code> found above it, else its git repo, else the directory. A path below
			the registry's folder in none of its repos opens as its git repo or directory instead, as does
			one under a registry in a checkout that can't be used — each says why. The repo holding the
			path is focused — its files are indexed and watched. A registry's own folder indexes only its
			loose files and its focused repos; focus or unfocus its other repos here or from the file
			tree.
		</p>
	</header>

	<!-- open a project -->
	<section class="mb_xl">
		<h2 class="mt_0"><Icon data={icon_add} /> Open a File or Folder</h2>
		<form
			class="row gap_sm"
			onsubmit={(e) => {
				e.preventDefault();
				void handle_open();
			}}
		>
			<input
				type="text"
				bind:value={new_path}
				placeholder="~/dev/project or /home/you/dev/project"
				class="flex:1"
				disabled={opening}
			/>
			<button type="submit" disabled={opening || !new_path.trim()}>
				{opening ? 'opening...' : 'open'}
			</button>
		</form>
		{#if error_message}
			<p class="color_c_60 mt_sm">{error_message}</p>
		{:else if opened_message}
			<p class="text_50 mt_sm">{opened_message}</p>
		{/if}
	</section>

	<!-- list open projects -->
	<section>
		<h2 class="mt_0"><Icon data={icon_directory} /> Open Projects</h2>
		{#if app.projects.items.by_id.size === 0}
			<p class="text_50">
				No projects open. Use the form above or run <code>zzz &lt;path&gt;</code> to open one.
			</p>
		{:else}
			<ul class="unstyled">
				{#each app.projects.items.values as project (project.id)}
					<li class="p_sm">
						<div class="row gap_sm">
							<button
								type="button"
								class="flex:1 text-align:left gap_sm"
								class:selected={project.id === app.projects.active_id}
								aria-pressed={project.id === app.projects.active_id}
								onclick={() => app.intents.project_activate({ root: project.root })}
							>
								<Icon data={icon_project} />
								<span class="flex:1">
									<strong>{project.name}</strong>
									<span class="text_50 font_size_sm font_family_mono ml_sm">{project.root}</span>
									<small class="text_50 ml_sm">{KIND_LABELS[project.kind]}</small>
									{#if project.fallback}
										<small class="text_50 block">
											{format_project_fallback(project.fallback)}
										</small>
									{/if}
									{#if project.watch_status === 'degraded'}
										<small class="text_50 block">{PROJECT_DEGRADED_NOTICE}</small>
									{/if}
								</span>
							</button>
							<button
								type="button"
								class="icon-button sized_sm plain"
								title="close project"
								onclick={() => void handle_close(project.root)}
							>
								<Icon data={icon_delete} />
							</button>
						</div>
						{#if project.kind === 'registry'}
							<ProjectRegistryEntries
								{project}
								ontoggle={(dir) => void toggle_focus(project, dir)}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<PageFooter />

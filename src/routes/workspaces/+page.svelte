<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { frontend_context } from '$lib/frontend.svelte.ts';
	import { DiskfileDirectoryPath } from '$lib/diskfile_types.ts';
	import { parse_workspace_path } from '$lib/workspace_helpers.ts';
	import { icon_add, icon_delete, icon_directory, icon_workspace } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import PageFooter from '$routes/PageFooter.svelte';

	const app = frontend_context.get();

	let new_path = $state.raw('');
	let opening = $state.raw(false);
	let error_message: string | null = $state.raw(null);

	/**
	 * Open the workspace at `path` and activate it. Activates by the path the
	 * daemon returns — it canonicalizes (`/a/./b/` → `/a/b/`, symlinks
	 * resolved), so the input path may not match the stored workspace.
	 *
	 * @returns an error message, or `null` on success
	 */
	const open_and_activate = async (path: DiskfileDirectoryPath): Promise<string | null> => {
		const result = await app.api.workspace_open({ path });
		if (!result.ok) return result.error.message;
		// `add` is idempotent — the response handler has usually added it already
		const workspace = app.workspaces.add(result.value.workspace);
		app.workspaces.activate(workspace.id);
		return null;
	};

	// Auto-open/activate workspace from query param (e.g. from `zzz <dir>` CLI)
	const workspace_param = $derived(page.url.searchParams.get('workspace'));

	// Non-reactive: each param value is handled once, then stripped from the URL.
	// Reset when the param clears so navigating to the same value again reopens.
	let last_handled_param: string | null = null;

	$effect(() => {
		const param = workspace_param;
		if (param === null) {
			last_handled_param = null;
			return;
		}
		if (param === last_handled_param) return;
		last_handled_param = param;
		// untracked so workspace collection changes (a close, another open)
		// never re-run this — which would reopen a just-closed workspace or
		// steal the user's selection
		untrack(() => void handle_workspace_param(param));
	});

	const handle_workspace_param = async (param: string): Promise<void> => {
		// strip first so a reload never re-opens a workspace the user has since closed
		void goto(resolve('/workspaces'), { replaceState: true, keepFocus: true, noScroll: true });

		const parsed = parse_workspace_path(param);
		if (!parsed.ok) {
			error_message = `can't open workspace from URL: ${parsed.message}`;
			return;
		}
		const existing = app.workspaces.get_by_path(parsed.path);
		if (existing) {
			app.workspaces.activate(existing.id);
			return;
		}
		const error = await open_and_activate(parsed.path);
		if (error !== null) error_message = error;
	};

	const handle_open = async (): Promise<void> => {
		if (opening) return;
		const raw = new_path.trim();
		if (!raw) return;

		error_message = null;
		const parsed = parse_workspace_path(raw);
		if (!parsed.ok) {
			error_message = parsed.message;
			return;
		}

		opening = true;
		try {
			const error = await open_and_activate(parsed.path);
			if (error === null) {
				new_path = '';
			} else {
				error_message = error;
			}
		} finally {
			opening = false;
		}
	};

	const handle_close = async (path: string): Promise<void> => {
		await app.api.workspace_close({ path: DiskfileDirectoryPath.parse(path) });
	};
</script>

<div class="workspaces_page p_xl">
	<header class="mb_xl">
		<h1><Svg data={icon_workspace} /> Workspaces</h1>
		<p class="text_50">
			Directories the daemon is watching. Open a workspace to access its files and receive change
			events.
		</p>
	</header>

	<!-- open a workspace -->
	<section class="box mb_xl">
		<h2 class="mt_0"><Svg data={icon_add} /> Open Workspace</h2>
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
				placeholder="/home/user/project"
				class="flex:1"
				disabled={opening}
			/>
			<button type="submit" disabled={opening || !new_path.trim()}>
				{opening ? 'opening...' : 'open'}
			</button>
		</form>
		{#if error_message}
			<p class="color_c_50 mt_sm">{error_message}</p>
		{/if}
	</section>

	<!-- list open workspaces -->
	<section class="box">
		<h2 class="mt_0"><Svg data={icon_directory} /> Open Workspaces</h2>
		{#if app.workspaces.items.by_id.size === 0}
			<p class="text_50">
				No workspaces open. Use the form above or run <code>zzz &lt;dir&gt;</code> to open one.
			</p>
		{:else}
			<ul class="unstyled">
				{#each app.workspaces.items.values as workspace (workspace.id)}
					<li class="row gap_sm p_sm">
						<button
							type="button"
							class="flex:1 text-align:left gap_sm"
							class:selected={workspace.id === app.workspaces.active_id}
							onclick={() => app.workspaces.activate(workspace.id)}
						>
							<Svg data={icon_workspace} />
							<span class="flex:1">
								<strong>{workspace.name}</strong>
								<span class="text_50 font_size_sm font_family_mono ml_sm">{workspace.path}</span>
							</span>
						</button>
						<button
							type="button"
							class="icon-button compact plain"
							title="close workspace"
							onclick={() => void handle_close(workspace.path)}
						>
							<Svg data={icon_delete} />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<PageFooter />

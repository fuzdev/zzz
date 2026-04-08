<script lang="ts">
	// TODO: handle ?workspace= query param — auto-activate workspace on page load (sent by `zzz <dir>` CLI)
	import {frontend_context} from '$lib/frontend.svelte.js';
	import {DiskfileDirectoryPath} from '$lib/diskfile_types.js';
	import Glyph from '$lib/Glyph.svelte';
	import {GLYPH_WORKSPACE, GLYPH_DELETE, GLYPH_ADD, GLYPH_DIRECTORY} from '$lib/glyphs.js';
	import PageFooter from '$routes/PageFooter.svelte';

	const app = frontend_context.get();

	let new_path = $state('');
	let opening = $state(false);
	let error_message: string | null = $state(null);

	const handle_open = async (): Promise<void> => {
		const raw = new_path.trim();
		if (!raw) return;

		opening = true;
		error_message = null;

		const path = DiskfileDirectoryPath.parse(raw.endsWith('/') ? raw : raw + '/');
		const result = await app.api.workspace_open({path});

		if (result.ok) {
			new_path = '';
		} else {
			error_message = result.error.message;
		}
		opening = false;
	};

	const handle_close = async (path: string): Promise<void> => {
		await app.api.workspace_close({path: DiskfileDirectoryPath.parse(path)});
	};
</script>

<div class="workspaces_page p_xl">
	<header class="mb_xl">
		<h1><Glyph glyph={GLYPH_WORKSPACE} /> Workspaces</h1>
		<p class="text_50">
			Directories the daemon is watching. Open a workspace to access its files and receive change
			events.
		</p>
	</header>

	<!-- open a workspace -->
	<section class="box mb_xl">
		<h2 class="mt_0"><Glyph glyph={GLYPH_ADD} /> Open Workspace</h2>
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
		<h2 class="mt_0"><Glyph glyph={GLYPH_DIRECTORY} /> Open Workspaces</h2>
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
							<Glyph glyph={GLYPH_WORKSPACE} />
							<span class="flex:1">
								<strong>{workspace.name}</strong>
								<span class="text_50 font_size_sm font_family_mono ml_sm">{workspace.path}</span>
							</span>
						</button>
						<button
							type="button"
							class="icon_button compact plain"
							title="close workspace"
							onclick={() => void handle_close(workspace.path)}
						>
							<Glyph glyph={GLYPH_DELETE} />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<PageFooter />

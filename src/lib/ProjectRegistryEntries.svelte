<script lang="ts">
	import { untrack } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileDirectoryPath } from './diskfile_types.ts';
	import type { Project } from './project.svelte.ts';
	import {
		format_status_kind,
		format_repo_status,
		RepoStatusPoll
	} from './repo_status_poll.svelte.ts';

	const {
		project,
		ontoggle
	}: {
		/** A registry project; its root never changes for one instance. */
		project: Project;
		/** Focus or unfocus the entry at `dir`. */
		ontoggle: (dir: DiskfileDirectoryPath) => void;
	} = $props();

	const app = frontend_context.get();

	// one poll for the component's life, so its statuses outlive a hidden tab
	const poll = new RepoStatusPoll({
		root: untrack(() => project.root),
		fetch_status: (input) => app.api.project_status(input)
	});

	let visibility: DocumentVisibilityState = $state.raw('visible');

	// polled only while shown: mounted, and the tab visible
	$effect(() => {
		if (visibility !== 'visible') return;
		// untracked: a poll's call writes the actions state this would read
		untrack(() => poll.start());
		return () => poll.stop();
	});

	/** `dir` relative to `root` when under it, for a shorter listing. */
	const to_relative = (dir: string, root: string): string =>
		dir.startsWith(root) && dir !== root ? dir.slice(root.length) : dir;
</script>

<svelte:document bind:visibilityState={visibility} />

<p class="font_size_sm text_50 mb_0">
	{project.entries.length}
	{project.entries.length === 1 ? 'entry' : 'entries'} in
	<span class="font_family_mono">{project.registry_path}</span>
	— {project.focused.length || 'none'} focused
	<button
		type="button"
		class="sized_sm plain"
		title="read every repo's git status again"
		onclick={() => poll.refresh()}
	>
		refresh status
	</button>
</p>
{#if poll.error}
	<p class="font_size_sm color_c_60 mb_0">status: {poll.error}</p>
{/if}
<ul class="unstyled font_size_sm">
	{#each project.entries as entry (`${entry.kind}:${entry.key}`)}
		{@const focused = project.focused.includes(entry.dir)}
		{@const status = entry.state === 'present' ? poll.statuses.get(entry.key) : undefined}
		<li class="row gap_sm">
			<span class="font_family_mono" class:text_50={!focused}>
				{to_relative(entry.dir, project.root)}
			</span>
			{#if entry.kind === 'reference'}<small class="text_50">reference</small>{/if}
			{#if entry.state === 'present'}
				<button
					type="button"
					class="sized_sm plain"
					disabled={app.projects.pending_repos.has(entry.dir)}
					title={focused ? 'stop indexing its files' : 'index and watch its files'}
					onclick={() => ontoggle(entry.dir)}
				>
					{app.projects.pending_repos.has(entry.dir)
						? focused
							? 'unfocusing…'
							: 'focusing…'
						: focused
							? 'unfocus'
							: 'focus'}
				</button>
				{#if !status || status.state === 'pending'}
					<small class="text_50">…</small>
				{:else if status.state === 'ok'}
					{@const summary = format_repo_status(status)}
					<small
						class:text_50={!summary}
						title={status.needs_human.map(format_status_kind).join(', ') || undefined}
					>
						{summary || 'clean'}{status.needs_human.length ? ' — needs you' : ''}
					</small>
				{:else if status.state === 'failed'}
					<small class="color_c_60" title={status.error ?? undefined}>status failed</small>
				{:else if status.state === 'not_a_repo'}
					<small class="text_50">not a repo</small>
				{:else if status.state === 'missing'}
					<small class="text_50">gone</small>
				{/if}
				{#if status?.probing && status.state !== 'pending'}
					<small class="text_50" title="reading its status">…</small>
				{/if}
			{:else if entry.state === 'missing'}
				<small class="text_50">not cloned</small>
			{:else}
				<small class="text_50">refused: {entry.reason}</small>
			{/if}
		</li>
	{/each}
</ul>

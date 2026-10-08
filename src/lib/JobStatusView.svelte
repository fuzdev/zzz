<script lang="ts">
	import { frontend_context } from './frontend.svelte.ts';
	import type { Job } from './job.svelte.ts';
	import { format_recording_duration } from './recording_helpers.ts';

	/*

	One job's state: where it is, how far along, and — when it failed — why.
	Everything a tool said (the error, its stderr, the command lines) derives from
	the file it was run on, so it's all rendered as text.

	*/

	const {
		job,
		show_input = false
	}: {
		job: Job;
		/** Show the file the job works on — for a list of jobs across files. */
		show_input?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();

	let cancel_error: string | null = $state.raw(null);

	const cancel = async (): Promise<void> => {
		cancel_error = null;
		const result = await app.jobs.cancel(job);
		if (!result.ok) cancel_error = result.error.message;
	};

	const percent = $derived(job.progress === null ? null : Math.round(job.progress * 100));
</script>

<div class="job-status">
	<div class="row gap_sm flex-wrap:wrap">
		<span class="chip" class:color_c_50={job.status === 'failed'}>{job.status}</span>
		<span>{job.kind}</span>
		{#if show_input}
			<small class="word-break:break-all" title={job.input_path}>
				{app.diskfiles.to_relative_path(job.input_path) || job.input_path}
			</small>
		{/if}
		{#if job.status === 'running'}
			{#if percent === null}
				<small class="text_50">working…</small>
			{:else}
				<progress max="100" value={percent}></progress>
				<small class="font_family_mono">{percent}%</small>
			{/if}
		{:else if job.run_duration !== null}
			<small class="text_50">ran {format_recording_duration(job.run_duration)}</small>
		{/if}
		{#if job.cancellable}
			<button type="button" class="plain sized_sm" onclick={cancel}>cancel</button>
		{/if}
	</div>
	{#if cancel_error !== null}
		<p class="color_c_50 mb_0">couldn't cancel: {cancel_error}</p>
	{/if}
	{#if job.error !== null}
		<p class="color_c_50 mb_0">{job.error}</p>
	{/if}
	{#if job.stderr}
		<pre class="stderr font_size_sm">{job.stderr}</pre>
	{/if}
	{#if job.commands.length > 0}
		<details>
			<summary><small class="text_50">commands run</small></summary>
			{#each job.commands as command, index (index)}
				<pre class="font_size_sm">{command}</pre>
			{/each}
		</details>
	{/if}
</div>

<style>
	.job-status {
		display: flex;
		flex-direction: column;
		gap: var(--space_xs);
	}
	pre {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.stderr {
		max-height: 12em;
		overflow: auto;
	}
</style>

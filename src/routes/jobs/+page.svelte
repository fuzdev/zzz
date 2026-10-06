<script lang="ts">
	import { frontend_context } from '$lib/frontend.svelte.ts';
	import JobStatusView from '$lib/JobStatusView.svelte';
	import PageFooter from '$routes/PageFooter.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { DiskfilePath } from '$lib/diskfile_types.ts';

	const app = frontend_context.get();
	const { jobs } = app;

	const open_file = (path: DiskfilePath): void => {
		const diskfile = app.diskfiles.get_by_path(path);
		if (!diskfile) return;
		app.diskfiles.select(diskfile.id, true);
		void goto(resolve('/files'));
	};
</script>

<div class="p_lg">
	<header class="mb_lg">
		<h1>Jobs</h1>
		<p>
			Long-running work the daemon does on your files — a transcription — one at a time, in the
			order it was asked for. Jobs live in the daemon's memory: they end with it, and the files they
			wrote stay.
		</p>
	</header>

	{#if jobs.newest_first.length === 0}
		<p class="text_50">no jobs yet — transcribe an audio file to start one</p>
	{:else}
		<ul class="unstyled column gap_md">
			{#each jobs.newest_first as job (job.id)}
				<li class="panel p_md">
					<JobStatusView {job} show_input />
					<div class="row gap_sm mt_xs">
						<button
							type="button"
							class="plain sm"
							disabled={!app.diskfiles.get_by_path(job.input_path)}
							onclick={() => open_file(job.input_path)}
						>
							open input
						</button>
						{#if job.output_path}
							{@const output_path = job.output_path}
							<button
								type="button"
								class="plain sm"
								disabled={!app.diskfiles.get_by_path(output_path)}
								onclick={() => open_file(output_path)}
							>
								open output
							</button>
						{/if}
						<small class="text_50 font_family_mono">{job.job_id}</small>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<PageFooter />

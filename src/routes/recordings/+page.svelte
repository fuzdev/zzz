<script lang="ts">
	import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import { icon_delete, icon_pause, icon_stop } from '@fuzdev/fuz_ui/icons.ts';
	import { to_error_message } from '@fuzdev/fuz_util/error.ts';

	import { frontend_context } from '#lib/frontend.svelte.ts';
	import type { Diskfile } from '#lib/diskfile.svelte.ts';
	import { DiskfileDirectoryPath, type DiskfilePath } from '#lib/diskfile_types.ts';
	import { to_diskfile_content_kind } from '#lib/diskfile_content_kind.ts';
	import Icon from '#lib/Icon.svelte';
	import JobStatusView from '#lib/JobStatusView.svelte';
	import { icon_microphone, icon_record } from '#lib/media_icons.ts';
	import { format_recording_duration, to_recordings_dir } from '#lib/recording_helpers.ts';
	import { find_transcripts } from '#lib/transcript_helpers.ts';
	import PageFooter from '#routes/PageFooter.svelte';

	const app = frontend_context.get();
	const { recorder, diskfiles, jobs } = app;

	// `recordings/` in the app directory: no project needed, and out of any repo
	const recordings_dir = $derived(
		app.zzz_dir ? parse_or_throw(DiskfileDirectoryPath, to_recordings_dir(app.zzz_dir)) : null
	);

	// the recordings' paths, newest first — a recording's name is when it started;
	// walked from the tree index, so it costs the folder, not the whole index
	const recordings: Array<DiskfilePath> = $derived.by(() => {
		if (recordings_dir === null) return [];
		const { tree_index } = diskfiles.index;
		const paths: Array<DiskfilePath> = [];
		const dirs: Array<string> = [recordings_dir];
		for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
			const children = tree_index.get_children(dir);
			dirs.push(...children.dirs);
			for (const path of children.files) {
				if (to_diskfile_content_kind(path) === 'audio') paths.push(path as DiskfilePath);
			}
		}
		return paths.sort((a, b) => (a < b ? 1 : -1));
	});

	const to_name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

	/**
	 * The files that may be the recording's transcripts — their contents say
	 * which, so the page holds them (`hold_all`).
	 */
	const to_candidates = (path: DiskfilePath): Array<Diskfile> =>
		diskfiles
			.to_transcript_candidate_paths(path)
			.map((candidate) => diskfiles.peek(candidate))
			.filter((candidate) => candidate !== undefined);

	$effect(() =>
		diskfiles.hold_all(recordings.flatMap((path) => diskfiles.to_transcript_candidate_paths(path)))
	);

	const is_loading = (diskfile: Diskfile): boolean =>
		diskfile.content_status === 'unrequested' || diskfile.content_status === 'loading';

	// the transcripts' contents say which recording they're of, so they load with the page
	$effect(() => {
		for (const recording of recordings) {
			for (const candidate of to_candidates(recording)) void diskfiles.ensure_content(candidate);
		}
	});

	const open = (path: DiskfilePath): void => {
		app.intents.tab_open({ path, permanent: true });
		app.intents.view_show({ view: 'files' });
	};

	let error_message: string | null = $state.raw(null);

	const transcribe = async (path: DiskfilePath): Promise<void> => {
		error_message = null;
		const result = await jobs.transcribe(path);
		if (!result.ok) error_message = `couldn't transcribe ${to_name(path)}: ${result.error.message}`;
	};

	/** Deletes a recording with its transcripts — here they're one thing. */
	const delete_recording = async (path: DiskfilePath): Promise<void> => {
		error_message = null;
		try {
			const candidates = to_candidates(path);
			await Promise.all(candidates.map((candidate) => diskfiles.ensure_content(candidate)));
			for (const { file } of find_transcripts(candidates, path)) {
				await diskfiles.delete(file.path);
			}
			await diskfiles.delete(path);
		} catch (error) {
			error_message = `couldn't delete ${to_name(path)}: ${to_error_message(error)}`;
		}
	};
</script>

<div class="p_lg">
	<header class="mb_lg">
		<h1>Recordings</h1>
		<p>
			Record the microphone to a file, and transcribe it with a speech model on this machine. The
			audio is kept, and sent nowhere.
		</p>
	</header>

	<section class="recorder panel p_md mb_lg">
		{#if recorder.status === 'idle'}
			<PendingButton
				pending={false}
				disabled={recordings_dir === null}
				title={recordings_dir === null
					? 'waiting for the session to load'
					: `record to a new file in ${recordings_dir}`}
				onclick={() => {
					// in the click itself: the microphone opens only on a user gesture
					if (recordings_dir) recorder.start(recordings_dir).catch(() => undefined);
				}}
			>
				<Icon data={icon_microphone} /> <span class="ml_xs">record</span>
			</PendingButton>
		{:else}
			<div class="row_wrap gap_sm">
				<strong>{recorder.status}</strong>
				<span class="font_family_mono">{format_recording_duration(recorder.duration)}</span>
				{#if recorder.status === 'recording'}
					<button type="button" onclick={() => recorder.pause()}>
						<Icon data={icon_pause} /> <span class="ml_xs">pause</span>
					</button>
				{:else if recorder.status === 'paused'}
					<button type="button" onclick={() => recorder.resume()}>
						<Icon data={icon_record} /> <span class="ml_xs">resume</span>
					</button>
				{/if}
				{#if recorder.status !== 'stopping'}
					<button type="button" onclick={() => recorder.stop()}>
						<Icon data={icon_stop} /> <span class="ml_xs">stop</span>
					</button>
				{/if}
			</div>
			<meter
				class="level"
				min="0"
				max="1"
				value={recorder.level}
				title="microphone level"
				aria-label="microphone level"
			></meter>
		{/if}
		<label class="row gap_xs mb_0 mt_sm">
			<input type="checkbox" bind:checked={recorder.transcribe_on_stop} />
			<span>transcribe when a recording stops</span>
		</label>
		{#if recorder.error !== null}
			<p class="color_c_60 mb_0 mt_sm">{recorder.error}</p>
		{/if}
	</section>

	{#if error_message !== null}
		<p class="color_c_60">{error_message}</p>
	{/if}

	{#if recordings.length === 0}
		<p class="text_50">no recordings yet</p>
	{:else}
		<ul class="unstyled column gap_md">
			{#each recordings as path (path)}
				{@const candidates = to_candidates(path)}
				{@const transcripts = find_transcripts(candidates, path)}
				{@const transcripts_loading = candidates.some(is_loading)}
				{@const job = jobs.latest_for_input(path)}
				{@const is_recording = recorder.path === path}
				<li class="panel p_md">
					<div class="row_wrap gap_sm">
						<button type="button" class="plain" onclick={() => open(path)}>
							{to_name(path)}
						</button>
						{#if is_recording}
							<small class="chip">recording</small>
						{:else if job && !job.finished}
							<!-- shown below -->
						{:else if transcripts_loading}
							<!-- the transcripts say so once they load -->
						{:else if transcripts.length > 0}
							<small class="text_50">
								transcribed by {transcripts.map((t) => t.transcript.tool.model).join(', ')}
							</small>
						{:else}
							<button type="button" class="plain sized_sm" onclick={() => transcribe(path)}>
								transcribe
							</button>
						{/if}
						{#if !is_recording}
							<ConfirmButton
								onconfirm={() => delete_recording(path)}
								class="plain icon-button"
								title={transcripts.length > 0
									? 'delete the recording and its transcripts'
									: 'delete the recording'}
							>
								<Icon data={icon_delete} />
							</ConfirmButton>
						{/if}
					</div>
					{#if job &&
						!is_recording &&
						(!job.finished || (transcripts.length === 0 && job.status !== 'succeeded'))
					}
						<div class="mt_sm"><JobStatusView {job} /></div>
					{/if}
					{#if transcripts[0] && transcripts[0].transcript.segments.length > 0}
						<p class="text_70 mb_0 mt_sm ellipsis">
							{transcripts[0].transcript.segments
								.slice(0, 3)
								.map((s) => s.text)
								.join(' ')}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<PageFooter />

<style>
	.level {
		display: block;
		width: 100%;
		margin-top: var(--space_sm);
	}
</style>

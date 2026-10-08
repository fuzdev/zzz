<script lang="ts">
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import { icon_delete, icon_file, icon_stop } from '@fuzdev/fuz_ui/icons.ts';
	import { to_error_message } from '@fuzdev/fuz_util/error.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import Icon from './Icon.svelte';
	import JobStatusView from './JobStatusView.svelte';
	import TranscriptSegments from './TranscriptSegments.svelte';
	import { delete_diskfile } from './diskfile_helpers.ts';
	import { DiskfilePath } from './diskfile_types.ts';
	import { to_file_bytes_url } from './file_bytes.ts';
	import { format_recording_duration } from './recording_helpers.ts';
	import {
		find_transcripts,
		to_transcript_copy_path,
		transcript_to_text
	} from './transcript_helpers.ts';

	/*

	An audio file: a player on the byte route, and its transcript beside it —
	the one on disk, or the one a job is writing now.

	*/

	const {
		diskfile
	}: {
		diskfile: Diskfile;
	} = $props();

	const app = frontend_context.get();
	const { recorder, jobs, diskfiles } = app;

	const url = $derived(app.api_url ? to_file_bytes_url(app.api_url, diskfile.path) : null);
	// the file being recorded right now grows every few seconds — don't load it until it's done
	const recording = $derived(recorder.path === diskfile.path);

	// which bytes failed to play — a new file, or new bytes at the same path, starts clean
	const playback_key = $derived(`${diskfile.path}:${diskfile.mtime}`);
	let playback_failed_key: string | null = $state.raw(null);
	const playback_failed = $derived(playback_failed_key === playback_key);

	let audio: HTMLAudioElement | undefined = $state.raw();
	let current_ms: number | null = $state.raw(null);

	let finalizing = $state.raw(false);
	let finalize_error: string | null = $state.raw(null);

	const finalize = async (): Promise<void> => {
		finalizing = true;
		finalize_error = null;
		const result = await app.api.media_finalize({ path: diskfile.path });
		finalizing = false;
		if (!result.ok) finalize_error = result.error.message;
	};

	// the transcripts on disk, one per model, and the job writing another
	const transcripts = $derived(find_transcripts(diskfiles.items.values, diskfile.path));
	// picked by the sidecar's path: two files can claim the same model
	let selected_path: string | null = $state.raw(null);
	const selected = $derived(
		transcripts.find((t) => t.file.path === selected_path) ?? transcripts[0]
	);
	const job = $derived(jobs.latest_for_input(diskfile.path));
	const job_unfinished = $derived(job !== undefined && !job.finished);

	let transcribe_pending = $state.raw(false);
	let transcribe_error: string | null = $state.raw(null);

	const transcribe = async (): Promise<void> => {
		transcribe_pending = true;
		transcribe_error = null;
		const result = await jobs.transcribe(diskfile.path);
		transcribe_pending = false;
		if (!result.ok) transcribe_error = result.error.message;
	};

	const seek = (ms: number): void => {
		if (!audio) return;
		audio.currentTime = ms / 1000;
		void audio.play();
	};

	let copy_error: string | null = $state.raw(null);

	const edit_a_copy = async (): Promise<void> => {
		if (!selected) return;
		copy_error = null;
		const path = to_transcript_copy_path(
			diskfile.path,
			(p) => diskfiles.get_by_path(DiskfilePath.parse(p)) !== undefined
		);
		try {
			await diskfiles.create_file_at(
				DiskfilePath.parse(path),
				transcript_to_text(selected.transcript)
			);
		} catch (error) {
			copy_error = to_error_message(error);
		}
	};
</script>

<DiskfileContextmenu {diskfile}>
	<div class="display:flex height:100%">
		<div class="flex:1 width_atleast_sm height:100% column p_md gap_md overflow:auto">
			{#if diskfile.deleted_on_disk}
				<p class="color_c_50">deleted on disk</p>
			{:else if recording}
				<p class="row gap_sm">
					<span>recording to this file</span>
					<span class="font_family_mono">{format_recording_duration(recorder.duration)}</span>
					<button type="button" class="sm" onclick={() => recorder.stop()}>
						<Icon data={icon_stop} /> <span class="ml_xs">stop</span>
					</button>
				</p>
			{:else if url === null}
				<p class="color_c_50">no backend to play this file from</p>
			{:else}
				<!-- remounted when the file's bytes change, so it loads them -->
				{#key diskfile.mtime}
					<audio
						bind:this={audio}
						controls
						preload="metadata"
						src={url}
						ontimeupdate={(e) => {
							current_ms = e.currentTarget.currentTime * 1000;
						}}
						onerror={() => {
							playback_failed_key = playback_key;
						}}
					></audio>
				{/key}
				{#if playback_failed}
					<p class="color_c_50">
						the browser couldn't play this file — it may not be audio, or use a codec the browser
						lacks
					</p>
				{/if}
			{/if}
			{#if finalize_error !== null}
				<p class="color_c_50">couldn't finalize: {finalize_error}</p>
			{/if}

			{#if !recording && !diskfile.deleted_on_disk}
				<section class="transcript">
					{#if job && job_unfinished}
						<JobStatusView {job} />
						{#if job.live_segments.length > 0}
							<TranscriptSegments segments={job.live_segments} onseek={seek} {current_ms} />
						{/if}
					{:else if selected}
						<div class="row gap_sm flex-wrap:wrap mb_sm">
							<small class="text_50">
								transcript by
								{#if transcripts.length > 1}
									<select
										class="inline sm"
										value={selected.file.path}
										onchange={(e) => {
											selected_path = e.currentTarget.value;
										}}
									>
										{#each transcripts as { file, transcript } (file.path)}
											<option value={file.path}>{transcript.tool.model}</option>
										{/each}
									</select>
								{:else}
									{selected.transcript.tool.model}
								{/if}
								{#if selected.transcript.language}
									· {selected.transcript.language}
								{/if}
							</small>
							<button
								type="button"
								class="plain sm"
								title="create a text file from this transcript and open it — the transcript itself is never edited"
								onclick={edit_a_copy}
							>
								edit a copy
							</button>
							<button
								type="button"
								class="plain sm"
								title="open the transcript file"
								onclick={() => diskfiles.select(selected.file.id, true)}
							>
								open file
							</button>
						</div>
						{#if copy_error !== null}
							<p class="color_c_50">couldn't create the copy: {copy_error}</p>
						{/if}
						{#if selected.transcript.segments.length > 0}
							<TranscriptSegments
								segments={selected.transcript.segments}
								onseek={seek}
								{current_ms}
							/>
						{:else}
							<p class="text_50">no speech was recognized</p>
						{/if}
					{:else}
						<div class="row gap_sm flex-wrap:wrap">
							<PendingButton
								pending={transcribe_pending}
								title="transcribe this file with the local speech model"
								onclick={transcribe}
							>
								transcribe
							</PendingButton>
							<small class="text_50">runs on this machine — the audio is sent nowhere</small>
						</div>
						{#if transcribe_error !== null}
							<p class="color_c_50">couldn't start: {transcribe_error}</p>
						{:else if job}
							<!-- the last attempt, failed or cancelled -->
							<JobStatusView {job} />
						{/if}
					{/if}
				</section>
			{/if}
		</div>

		<div class="width_atmost_sm width_atleast_sm py_md">
			<div class="px_md mb_lg display:flex gap_xs">
				<PendingButton
					pending={finalizing}
					disabled={recording || diskfile.deleted_on_disk}
					class="plain"
					title="rewrite the file so it has a duration and seeks — for a recording that was cut off before it was saved"
					onclick={finalize}
				>
					finalize
				</PendingButton>
				{#if url !== null && !recording && !diskfile.deleted_on_disk}
					<a
						class="chip"
						href={/* eslint-disable-line svelte/no-navigation-without-resolve */ url}
						download={diskfile.path.slice(diskfile.path.lastIndexOf('/') + 1)}
					>
						download
					</a>
				{/if}
				<ConfirmButton
					onconfirm={() => delete_diskfile(app.diskfiles, diskfile)}
					class="plain icon-button"
					title="delete file"
				>
					<Icon data={icon_delete} />
				</ConfirmButton>
			</div>

			<div class="px_md mb_lg display:flex flex-direction:column gap_xs width:100%">
				<small class="overflow_wrap_break_all width:100%">
					<Icon data={icon_file} />
					{app.diskfiles.to_relative_path(diskfile.path)}
				</small>
				<small>
					<div>created {diskfile.created_formatted_datetime}</div>
					{#if diskfile.updated_formatted_datetime !== diskfile.created_formatted_datetime}
						<div>updated {diskfile.updated_formatted_datetime}</div>
					{/if}
				</small>
				<small class="font_family_mono">{diskfile.id}</small>
			</div>
		</div>
	</div>
</DiskfileContextmenu>

<style>
	audio {
		width: 100%;
		flex-shrink: 0;
	}
</style>

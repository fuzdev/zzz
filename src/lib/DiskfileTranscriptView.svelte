<script lang="ts">
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';
	import { icon_delete, icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import { to_error_message } from '@fuzdev/fuz_util/error.ts';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import DiskfileEditorView from './DiskfileEditorView.svelte';
	import Icon from './Icon.svelte';
	import TranscriptSegments from './TranscriptSegments.svelte';
	import { delete_diskfile } from './diskfile_helpers.ts';
	import { DiskfilePath } from './diskfile_types.ts';
	import { to_file_bytes_url } from './file_bytes.ts';
	import {
		parse_transcript,
		to_transcript_copy_path,
		to_transcript_source_path,
		transcript_to_text
	} from './transcript_helpers.ts';

	/*

	A transcript sidecar, read-only: tool output is never edited — "edit a copy" makes
	the text to work on. With the audio beside it, a segment plays from where it was said.
	A file named like a transcript that isn't one falls back to the text editor.

	*/

	const {
		diskfile,
		onmodified
	}: {
		diskfile: Diskfile;
		onmodified?: (diskfile_id: Uuid) => void;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;

	const transcript = $derived(parse_transcript(diskfile.content));
	const source_path = $derived(
		transcript ? DiskfilePath.parse(to_transcript_source_path(diskfile.path, transcript)) : null
	);
	const source = $derived(source_path ? diskfiles.get_by_path(source_path) : undefined);
	const source_url = $derived(
		source && !source.deleted_on_disk && app.api_url
			? to_file_bytes_url(app.api_url, source.path)
			: null
	);

	let audio: HTMLAudioElement | undefined = $state.raw();
	let current_ms: number | null = $state.raw(null);

	const seek = (ms: number): void => {
		if (!audio) return;
		audio.currentTime = ms / 1000;
		void audio.play();
	};

	let copy_error: string | null = $state.raw(null);

	const edit_a_copy = async (): Promise<void> => {
		if (!transcript || !source_path) return;
		copy_error = null;
		const path = to_transcript_copy_path(
			source_path,
			(p) => diskfiles.get_by_path(DiskfilePath.parse(p)) !== undefined
		);
		try {
			await diskfiles.create_file_at(DiskfilePath.parse(path), transcript_to_text(transcript));
		} catch (error) {
			copy_error = to_error_message(error);
		}
	};
</script>

{#if transcript}
	<DiskfileContextmenu {diskfile}>
		<div class="display:flex height:100%">
			<div class="flex:1 width_atleast_sm height:100% column p_md gap_md overflow:auto">
				{#if source && source_url}
					{#key source.mtime}
						<audio
							bind:this={audio}
							controls
							preload="metadata"
							src={source_url}
							ontimeupdate={(e) => {
								current_ms = e.currentTarget.currentTime * 1000;
							}}
						></audio>
					{/key}
				{:else}
					<p class="text_50 mb_0">
						the audio this was made from, {transcript.source.name}, isn't beside it
					</p>
				{/if}
				{#if transcript.segments.length > 0}
					<TranscriptSegments
						segments={transcript.segments}
						onseek={source_url ? seek : undefined}
						{current_ms}
					/>
				{:else}
					<p class="text_50">no speech was recognized</p>
				{/if}
			</div>

			<div class="width_atmost_sm width_atleast_sm py_md">
				<div class="px_md mb_lg display:flex gap_xs">
					<button
						type="button"
						class="plain"
						title="create a text file from this transcript and open it — the transcript itself is never edited"
						onclick={edit_a_copy}
					>
						edit a copy
					</button>
					{#if source}
						<button
							type="button"
							class="plain"
							title="open the audio file"
							onclick={() => diskfiles.select(source.id, true)}
						>
							open audio
						</button>
					{/if}
					<ConfirmButton
						onconfirm={() => delete_diskfile(app.diskfiles, diskfile)}
						class="plain icon-button"
						title="delete this transcript — the audio can then be transcribed again"
					>
						<Icon data={icon_delete} />
					</ConfirmButton>
				</div>
				{#if copy_error !== null}
					<p class="px_md color_c_60">couldn't create the copy: {copy_error}</p>
				{/if}

				<div class="px_md mb_lg display:flex flex-direction:column gap_xs width:100%">
					<small class="word-break:break-all width:100%">
						<Icon data={icon_file} />
						{app.diskfiles.to_relative_path(diskfile.path)}
					</small>
					<small>
						<div>read-only — a transcript is tool output</div>
						<div>
							by {transcript.tool.backend} {transcript.tool.version ?? ''} · model
							{transcript.tool.model}
						</div>
						{#if transcript.language}
							<div>language {transcript.language}</div>
						{/if}
						<div>created {diskfile.created_formatted_datetime}</div>
					</small>
				</div>
			</div>
		</div>
	</DiskfileContextmenu>
{:else}
	<DiskfileEditorView {diskfile} {onmodified} />
{/if}

<style>
	audio {
		width: 100%;
		flex-shrink: 0;
	}
</style>

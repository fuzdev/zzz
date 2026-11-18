<script lang="ts">
	import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';
	import { icon_delete, icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import { to_error_message } from '@fuzdev/fuz_util/error.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import DiskfileDetailsDrawer from './DiskfileDetailsDrawer.svelte';
	import DiskfileEditorView from './DiskfileEditorView.svelte';
	import Icon from './Icon.svelte';
	import TranscriptSegments from './TranscriptSegments.svelte';
	import DiskfileLoadingNotice from './DiskfileLoadingNotice.svelte';
	import { DISKFILE_UNCOVERED_LABEL, delete_diskfile } from './diskfile_helpers.ts';
	import { DiskfilePath } from './diskfile_types.ts';
	import { to_file_bytes_url } from './file_bytes.ts';
	import {
		parse_transcript,
		to_transcript_copy_path,
		to_transcript_source_name,
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
		onmodified?: (path: DiskfilePath) => void;
	} = $props();

	const app = frontend_context.get();
	const { diskfiles } = app;

	// loads the content on view
	$effect(() => {
		void diskfiles.ensure_content(diskfile);
	});

	const loading = $derived(
		diskfile.content_status === 'unrequested' || diskfile.content_status === 'loading'
	);
	const transcript = $derived(parse_transcript(diskfile.content));
	// the sidecar's name is its link to the audio, beside it
	const source_name = $derived(to_transcript_source_name(diskfile.path));
	const source_path = $derived.by(() => {
		if (!transcript) return null;
		const path = to_transcript_source_path(diskfile.path);
		return path === null ? null : parse_or_throw(DiskfilePath, path);
	});
	// the audio's metadata alone — its cell when one is kept (deleted on disk or uncovered, for a
	// draft or a tab), else the index's record — never held, so it isn't read as text on a change
	const source: { path: DiskfilePath; mtime: number | null; deleted_on_disk: boolean } | undefined =
		$derived.by(() => {
			if (!source_path) return undefined;
			const cell = diskfiles.peek(source_path);
			if (cell) return cell;
			const record = diskfiles.get_by_path(source_path);
			return record && { path: source_path, mtime: record.mtime, deleted_on_disk: false };
		});
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
		if (!transcript || !source_path || source_name === null) return;
		copy_error = null;
		const path = to_transcript_copy_path(source_path, (p) => diskfiles.has_path(p));
		try {
			await diskfiles.create_file_at(
				parse_or_throw(DiskfilePath, path),
				transcript_to_text(transcript, source_name)
			);
		} catch (error) {
			copy_error = to_error_message(error);
		}
	};
</script>

{#if loading}
	<DiskfileContextmenu path={diskfile.path}>
		<DiskfileLoadingNotice attrs={{ class: 'p_md' }} />
	</DiskfileContextmenu>
{:else if transcript}
	<DiskfileContextmenu path={diskfile.path}>
		<!-- a stacking context, so the details drawer's z-index (over the segments it slides across)
		stays inside the view, under the desk menu's overlay -->
		<div class="flex height:100% isolation:isolate">
			<div class="flex:1 width_atleast_sm height:100% column p_md gap_md overflow:auto">
				{#if diskfile.deleted_on_disk}
					<p class="color_c_60">deleted on disk</p>
				{:else if diskfile.uncovered}
					<p class="text_50">{DISKFILE_UNCOVERED_LABEL}</p>
				{/if}
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
					<p class="text_50">
						{#if source_name === null}
							this file's name doesn't name the audio it was made from —
							<code>&lt;audio&gt;.&lt;model&gt;.transcript.json</code>
						{:else}
							the audio this was made from, {source_name}, isn't beside it
						{/if}
					</p>
				{/if}
				<!-- the drawer shows it beside "edit a copy", so here only with the drawer closed -->
				{#if !app.ui.show_diskfile_details && copy_error !== null}
					<p class="color_c_60">couldn't create the copy: {copy_error}</p>
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

			<DiskfileDetailsDrawer>
				<div class="px_md mb_lg flex gap_xs">
					<button
						type="button"
						class="plain"
						title="create a text file from this transcript and open it — the transcript itself is never edited"
						disabled={source_name === null}
						onclick={edit_a_copy}
					>
						edit a copy
					</button>
					{#if source}
						<button
							type="button"
							class="plain"
							title="open the audio file"
							onclick={() => app.intents.tab_open({ path: source.path, permanent: true })}
						>
							open audio
						</button>
					{/if}
					<ConfirmButton
						onconfirm={() => delete_diskfile(app.diskfiles, diskfile.path)}
						class="plain icon-button"
						title="delete this transcript — the audio can then be transcribed again"
					>
						<Icon data={icon_delete} />
					</ConfirmButton>
				</div>
				{#if copy_error !== null}
					<p class="px_md color_c_60">couldn't create the copy: {copy_error}</p>
				{/if}

				<div class="px_md mb_lg flex flex-direction:column gap_xs width:100%">
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
			</DiskfileDetailsDrawer>
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

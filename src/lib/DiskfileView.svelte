<script lang="ts">
	import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileAudioView from './DiskfileAudioView.svelte';
	import DiskfileEditorView from './DiskfileEditorView.svelte';
	import DiskfileMarkdownView from './DiskfileMarkdownView.svelte';
	import DiskfileTranscriptView from './DiskfileTranscriptView.svelte';
	import { to_diskfile_content_kind } from './diskfile_content_kind.ts';

	/*

	The one place that picks how a file is shown: by its content kind, else the text editor.

	Keyed on the file, so a switch mounts a fresh view: what a view holds for the file it shows - a
	caret, the outline's lights, a playback position, an error - never carries over to the next.
	What should outlive a switch lives in app state (`DiskfileEditorState`, `Ui`).

	*/

	const {
		diskfile,
		onmodified
	}: {
		diskfile: Diskfile;
		onmodified?: (diskfile_id: Uuid) => void;
	} = $props();

	const content_kind = $derived(to_diskfile_content_kind(diskfile.path));
</script>

<!-- TODO remember each file's scroll and caret in its `DiskfileEditorState`, so a return to a tab picks up where it left off -->
{#key diskfile.id}
	{#if content_kind === 'audio'}
		<DiskfileAudioView {diskfile} />
	{:else if content_kind === 'transcript'}
		<DiskfileTranscriptView {diskfile} {onmodified} />
	{:else if content_kind === 'markdown'}
		<DiskfileMarkdownView {diskfile} {onmodified} />
	{:else}
		<DiskfileEditorView {diskfile} {onmodified} />
	{/if}
{/key}

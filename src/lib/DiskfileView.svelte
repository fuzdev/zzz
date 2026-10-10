<script lang="ts">
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';

	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileAudioView from './DiskfileAudioView.svelte';
	import DiskfileEditorView from './DiskfileEditorView.svelte';
	import DiskfileMarkdownView from './DiskfileMarkdownView.svelte';
	import DiskfileTranscriptView from './DiskfileTranscriptView.svelte';
	import { to_diskfile_content_kind } from './diskfile_content_kind.ts';

	/*

	The one place that picks how a file is shown: by its content kind, else the text editor.

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

{#if content_kind === 'audio'}
	<DiskfileAudioView {diskfile} />
{:else if content_kind === 'transcript'}
	<DiskfileTranscriptView {diskfile} {onmodified} />
{:else if content_kind === 'markdown'}
	<DiskfileMarkdownView {diskfile} {onmodified} />
{:else}
	<DiskfileEditorView {diskfile} {onmodified} />
{/if}

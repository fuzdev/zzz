<script lang="ts">
	import { icon_close, icon_pause, icon_stop } from '@fuzdev/fuz_ui/icons.ts';

	import Icon from './Icon.svelte';
	import { icon_record } from './media_icons.ts';
	import type { Recorder } from './recorder.svelte.ts';
	import { format_recording_duration } from './recording_helpers.ts';

	/*

	Says the microphone is live, on every page, with the controls to pause and stop —
	and afterward, why a recording failed. Takes the recorder as a prop
	because it renders outside `FrontendRoot`, so that the docs pages have it too.

	*/

	const {
		recorder
	}: {
		recorder: Recorder;
	} = $props();

	const { status, path, error, duration } = $derived(recorder);
	const filename = $derived(path?.slice(path.lastIndexOf('/') + 1));
	const duration_text = $derived(format_recording_duration(duration));
</script>

{#if status !== 'idle' || error !== null}
	<div class="recorder-indicator panel shade_10 border_radius_xs" role="status">
		{#if status === 'starting'}
			<span class="dot"></span>
			<span>opening the microphone…</span>
			<button type="button" class="plain sm" title="cancel" onclick={() => recorder.stop()}>
				<Icon data={icon_close} />
			</button>
		{:else if status === 'recording' || status === 'paused'}
			<span class="dot" class:live={status === 'recording'}></span>
			<span>{status}</span>
			<span class="font_family_mono">{duration_text}</span>
			{#if filename}
				<small class="ellipsis text_50" title={path}>{filename}</small>
			{/if}
			<label
				class="row gap_xs3 mb_0"
				title="transcribe the recording, on this machine, once it's saved"
			>
				<input type="checkbox" class="sm" bind:checked={recorder.transcribe_on_stop} />
				<small>transcribe</small>
			</label>
			{#if status === 'recording'}
				<button
					type="button"
					class="plain sm"
					title="pause recording"
					onclick={() => recorder.pause()}
				>
					<Icon data={icon_pause} />
				</button>
			{:else}
				<button
					type="button"
					class="plain sm"
					title="resume recording"
					onclick={() => recorder.resume()}
				>
					<Icon data={icon_record} />
				</button>
			{/if}
			<button type="button" class="plain sm" title="stop recording" onclick={() => recorder.stop()}>
				<Icon data={icon_stop} />
			</button>
		{:else if status === 'stopping'}
			<span class="dot"></span>
			<span>saving the recording…</span>
			<span class="font_family_mono">{duration_text}</span>
		{:else if error !== null}
			<span class="color_c_50">recording: {error}</span>
			<button
				type="button"
				class="plain sm"
				title="dismiss"
				onclick={() => {
					recorder.error = null;
				}}
			>
				<Icon data={icon_close} />
			</button>
		{/if}
	</div>
{/if}

<style>
	.recorder-indicator {
		position: fixed;
		bottom: var(--space_lg);
		right: var(--space_lg);
		z-index: 2;
		display: flex;
		align-items: center;
		gap: var(--space_sm);
		max-width: calc(100% - 2 * var(--space_lg));
		padding: var(--space_xs) var(--space_sm);
	}
	.dot {
		flex-shrink: 0;
		width: var(--space_sm);
		height: var(--space_sm);
		border-radius: 50%;
		background-color: var(--text_50);
	}
	.dot.live {
		background-color: var(--color_c_50);
		animation: recorder-pulse 1.2s ease-in-out infinite;
	}
	@keyframes recorder-pulse {
		50% {
			opacity: 0.3;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot.live {
			animation: none;
		}
	}
</style>

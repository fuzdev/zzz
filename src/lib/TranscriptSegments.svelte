<script lang="ts">
	import type { TranscriptSegment } from './transcript_types.ts';
	import { format_transcript_time } from './transcript_helpers.ts';

	/*

	A transcript's segments as text, each with its start time. With `onseek`, a timed
	segment is a button that seeks there. Transcript text is whatever was said
	near a microphone — it's rendered as text, never as markup.

	*/

	const {
		segments,
		onseek,
		current_ms = null
	}: {
		segments: ReadonlyArray<TranscriptSegment>;
		/** Called with a segment's start, in milliseconds, when it's clicked. */
		onseek?: ((ms: number) => void) | undefined;
		/** The playback position, to mark the segment being spoken. */
		current_ms?: number | null | undefined;
	} = $props();

	const is_current = (segment: TranscriptSegment): boolean =>
		current_ms !== null &&
		segment.start_ms !== null &&
		segment.end_ms !== null &&
		current_ms >= segment.start_ms &&
		current_ms < segment.end_ms;
</script>

<ol class="unstyled transcript-segments">
	{#each segments as segment, index (index)}
		{@const start_ms = segment.start_ms}
		<li class:current={is_current(segment)}>
			{#if start_ms !== null && onseek}
				<button
					type="button"
					class="plain segment"
					title="play from {format_transcript_time(start_ms)}"
					onclick={() => onseek(start_ms)}
				>
					<small class="time font_family_mono text_50">{format_transcript_time(start_ms)}</small>
					<span>{segment.text}</span>
				</button>
			{:else}
				<div class="segment">
					<small class="time font_family_mono text_50">
						{start_ms === null ? '' : format_transcript_time(start_ms)}
					</small>
					<span>{segment.text}</span>
				</div>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.transcript-segments {
		display: flex;
		flex-direction: column;
	}
	.segment {
		display: flex;
		align-items: baseline;
		gap: var(--space_sm);
		width: 100%;
		padding: var(--space_xs3) var(--space_xs);
		text-align: left;
		font-weight: inherit;
		white-space: normal;
		justify-content: flex-start;
		flex-wrap: nowrap;
	}
	.segment span {
		flex: 1;
		min-width: 0;
	}
	.time {
		flex-shrink: 0;
		min-width: 3.5em;
	}
	.current .segment {
		background-color: var(--shade_20, var(--shade_10));
	}
</style>

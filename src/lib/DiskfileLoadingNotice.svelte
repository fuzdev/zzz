<script lang="ts" module>
	/** How long a content read runs before the notice shows its animation, in ms. */
	export const DISKFILE_LOADING_NOTICE_DELAY = 1_000;

	/** How long a content read runs before the notice says it's still loading, in ms. */
	export const DISKFILE_LOADING_NOTICE_SLOW_DELAY = 60_000;
</script>

<script lang="ts">
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import type { SvelteHTMLElements } from 'svelte/elements';

	import { DISKFILE_CONTENT_LOADING_MESSAGE } from './diskfile_helpers.ts';

	/**
	 * What a view shows while a file's content loads: nothing at first, so a
	 * read that lands quickly (most do) doesn't flash a notice, then the
	 * pending animation, then — for a read that's still going a minute later —
	 * the message. Mount it only while the content is loading; the timers start
	 * at mount.
	 */
	const {
		suffix,
		small = false,
		attrs
	}: {
		/** Follows the message, like what loading means for the view. */
		suffix?: string | undefined;
		small?: boolean | undefined;
		attrs?: SvelteHTMLElements['p'] | undefined;
	} = $props();

	let phase: 'hidden' | 'pending' | 'slow' = $state.raw('hidden');

	$effect(() => {
		const pending = setTimeout(() => (phase = 'pending'), DISKFILE_LOADING_NOTICE_DELAY);
		const slow = setTimeout(() => (phase = 'slow'), DISKFILE_LOADING_NOTICE_SLOW_DELAY);
		return () => {
			clearTimeout(pending);
			clearTimeout(slow);
		};
	});

	const message = $derived(
		'still ' + DISKFILE_CONTENT_LOADING_MESSAGE + (suffix ? ' — ' + suffix : '')
	);
</script>

{#if phase !== 'hidden'}
	<p {...attrs} class="text_50 {attrs?.class}" aria-live="polite">
		<span aria-hidden="true"><PendingAnimation inline /></span>
		{#if phase === 'slow'}
			{#if small}<small>{message}</small>{:else}{message}{/if}
		{/if}
	</p>
{/if}

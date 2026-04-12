<script lang="ts">
	import {slide} from 'svelte/transition';

	import type {Thread} from './thread.svelte.js';
	import TurnListitem from './TurnListitem.svelte';
	import {Scrollable} from './scrollable.svelte.js';
	import type {SvelteHTMLElements} from 'svelte/elements';

	const {
		thread,
		attrs,
	}: {
		thread: Thread;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	const scrollable = new Scrollable();

	const turns = $derived(thread.turns.values);
</script>

<div
	{...attrs}
	class="turn-list {attrs?.class}"
	{@attach scrollable.container}
	{@attach scrollable.target}
>
	<ul class="unstyled">
		{#each turns as turn (turn.id)}
			<li transition:slide>
				<TurnListitem {turn} />
			</li>
		{/each}
	</ul>
</div>

<style>
	.turn-list {
		display: flex;
		flex-direction: column-reverse; /* makes scrolling start at the bottom */
		overflow: auto;
		scrollbar-width: thin;
		flex: 1;
		border-radius: var(--border_radius_xs2);
	}
</style>

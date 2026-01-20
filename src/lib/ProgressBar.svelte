<script lang="ts">
	import type {Snippet} from 'svelte';

	const {
		value,
		text,
	}: {
		/**
		 * The percentage value of the progress bar, 0-100.
		 */
		value: number;
		text?: Snippet;
	} = $props();

	// TODO a11y
</script>

<div class="display:flex align-items:center gap_sm">
	{#if text}
		{@render text()}
	{:else}
		<small class="width_xl4 text-align:right">{value}%</small>
	{/if}
	<div
		class="flex:1 bg_5 border_radius_xs overflow:hidden"
		style:height="var(--progress_bar_height, 6px)"
	>
		<div class="bg_a_5 height:100%" style:width="{value}%"></div>
	</div>
</div>

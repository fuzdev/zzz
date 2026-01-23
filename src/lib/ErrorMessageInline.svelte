<script lang="ts">
	import type {Snippet} from 'svelte';
	import Glyph from './Glyph.svelte';
	import {GLYPH_ERROR} from './glyphs.js';

	const {
		glyph = GLYPH_ERROR,
		children,
	}: {
		glyph?: string | null;
		children: Snippet;
	} = $props();
</script>

<span class="color_c_50">
	{#if glyph}
		<Glyph {glyph} />
	{/if}
	{@render children()}
</span>

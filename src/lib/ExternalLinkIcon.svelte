<script lang="ts">
	import type {Snippet} from 'svelte';

	import {GLYPH_EXTERNAL_LINK} from './glyphs.js';
	import Glyph from './Glyph.svelte';

	const {
		children,
	}: {
		children?: Snippet<[text_icon: string]>;
	} = $props();
</script>

<sup class="font_size_xs font_family_mono white-space:nowrap"
	>[{#if children}{@render children(GLYPH_EXTERNAL_LINK)}{:else}<Glyph
			glyph={GLYPH_EXTERNAL_LINK}
		/>{/if}]</sup
>

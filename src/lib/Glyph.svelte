<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	const {
		glyph,
		size,
		...rest
	}: SvelteHTMLElements['span'] & {
		glyph: string;
		size?: string | undefined;
	} = $props();

	const DEFAULT_SIZE = 'var(--font_size, 1em)';
	const DEFAULT_FONT_SIZE = 'var(--font_size, inherit)';

	const final_size = $derived(size ?? DEFAULT_SIZE);
</script>

<span
	{...rest}
	class="glyph display:inline-block text-align:center line-height:1 white-space:nowrap font-weight:400 {rest.class}"
	style:width={final_size}
	style:height={final_size}
	style:min-width={final_size}
	style:min-height={final_size}
	style:font-size={size ?? DEFAULT_FONT_SIZE}>{glyph}</span
>

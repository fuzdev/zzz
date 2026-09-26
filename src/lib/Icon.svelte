<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	/**
	 * A text-sized `Svg` icon: `1em` square, inline with the text around it, and
	 * never squeezed by a flex container. A bare `Svg` is sized
	 * `var(--font_size, auto)` — text-sized only where fuz_css sets `--font_size`
	 * (headings, `font_size_*` classes), else `auto` — and fuz_css displays `svg`
	 * as a block capped at `max-width: 100%`, so beside text it can render huge,
	 * on its own line, or 0px wide in a shrinking button. Use `Svg` directly only
	 * with an explicit `size`.
	 *
	 * @module
	 */
	const {
		size = '1em',
		inline = true,
		shrink = false,
		style,
		...rest
	}: ComponentProps<typeof Svg> = $props();
</script>

<Svg
	{...rest}
	{size}
	{inline}
	{shrink}
	style={style ? `max-width: none; ${style}` : 'max-width: none'}
/>

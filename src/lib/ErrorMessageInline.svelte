<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import { icon_error } from '@fuzdev/fuz_ui/icons.ts';

	const {
		icon = icon_error,
		children
	}: {
		icon?: SvgData | null;
		children: Snippet;
	} = $props();
</script>

<span class="color_c_50">
	{#if icon}
		<Svg data={icon} />
	{/if}
	{@render children()}
</span>

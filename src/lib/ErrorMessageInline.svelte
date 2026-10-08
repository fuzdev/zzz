<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
	import Icon from './Icon.svelte';
	import { icon_error } from '@fuzdev/fuz_ui/icons.ts';

	const {
		icon = icon_error,
		children
	}: {
		icon?: SvgData | null;
		children: Snippet;
	} = $props();
</script>

<span class="color_c_60">
	{#if icon}
		<Icon data={icon} />
	{/if}
	{@render children()}
</span>

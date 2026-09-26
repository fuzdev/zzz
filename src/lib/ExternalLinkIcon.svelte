<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
	import Icon from './Icon.svelte';
	import { icon_external_link } from '@fuzdev/fuz_ui/icons.ts';

	const {
		children
	}: {
		children?: Snippet<[icon: SvgData]>;
	} = $props();
</script>

<sup class="font_size_xs font_family_mono white-space:nowrap">
	[{#if children}
		{@render children(icon_external_link)}
	{:else}
		<Icon data={icon_external_link} />
	{/if}]
</sup>

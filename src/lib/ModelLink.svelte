<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { SvelteHTMLElements } from 'svelte/elements';
	import { DEV } from 'esm-env';

	import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	import type { Model } from './model.svelte.ts';
	import ProviderLogo from './ProviderLogo.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';

	const {
		model,
		icon,
		children,
		...rest
	}: SvelteHTMLElements['a'] & {
		model: Model;
		/**
		 * Icon rendered before the model name. `SvgData` renders via `Svg`;
		 * `'logo'` renders the provider's brand logo.
		 */
		icon?: SvgData | 'logo' | undefined;
	} = $props();

	if (DEV) {
		$effect.pre(() => {
			if (icon && children) {
				console.error('icon and children are mutually exclusive');
			}
		});
	}

	const selected = $derived(page.url.pathname === resolve(`/models/${model.name}`));
</script>

<!-- TODO this contextmenu appears as a duplicate, I think a de-duped key is the best fix, not manually disabling it -->
<ModelContextmenu {model}>
	<a {...rest} href={resolve(`/models/${model.name}`)} class="selected-plain" class:selected>
		{#if children}
			{@render children()}
		{:else}
			{#if icon === 'logo'}
				<ProviderLogo name={model.provider_name} />&nbsp;
			{:else if icon}
				<Svg data={icon} inline />&nbsp;
			{/if}{model.name}
		{/if}
	</a>
</ModelContextmenu>

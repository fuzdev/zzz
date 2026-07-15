<script lang="ts">
	import type {Snippet} from 'svelte';
	import {resolve} from '$app/paths';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {page} from '$app/state';
	import {DEV} from 'esm-env';

	import type {SvgData} from '@fuzdev/fuz_ui/svg.ts';
	import {icon_provider} from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	import type {Provider} from './provider.svelte.ts';
	import ProviderLogo from './ProviderLogo.svelte';

	const {
		provider,
		icon,
		icon_props,
		label = 'title',
		fallback,
		children,
		...rest
	}: SvelteHTMLElements['a'] & {
		provider: Provider | null | undefined;
		/**
		 * Icon rendered before the label. `SvgData` renders via `Svg`;
		 * `'logo'` renders the provider's brand logo.
		 */
		icon?: SvgData | 'logo' | undefined;
		/**
		 * Props forwarded to the rendered icon, `ProviderLogo` or `Svg`.
		 */
		icon_props?: Record<string, any> | undefined;
		/**
		 * Which provider field labels the link. Defaults to `'title'`.
		 */
		label?: 'title' | 'name' | undefined;
		fallback?: Snippet | undefined;
	} = $props();

	if (DEV) {
		$effect.pre(() => {
			if (icon && children) {
				console.error('icon and children are mutually exclusive');
			}
		});
	}

	const selected = $derived(
		!!provider && page.url.pathname === resolve(`/providers/${provider.name}`),
	);
</script>

<!-- whitespace is tricky here, the icon branches control it with an explicit nbsp -->
{#if provider}
	<a {...rest} href={resolve(`/providers/${provider.name}`)} class="selected-plain" class:selected
		>{#if children}
			{@render children()}
		{:else}
			{#if icon === 'logo'}
				<ProviderLogo name={provider.name} {...icon_props} />&nbsp;
			{:else if icon}
				<Svg data={icon} inline {...icon_props} />&nbsp;
			{/if}{label === 'name' ? provider.name : provider.title}
		{/if}</a
	>
{:else if fallback}
	{@render fallback()}
{:else}
	<small class="font_family_mono palette_c_50"><Svg data={icon_provider} /> missing provider</small>
{/if}

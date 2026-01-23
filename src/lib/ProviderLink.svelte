<script lang="ts">
	import type {Snippet} from 'svelte';
	import {resolve} from '$app/paths';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {page} from '$app/state';

	import type {Provider} from './provider.svelte.js';
	import {GLYPH_PROVIDER} from './glyphs.js';
	import ProviderLogo from './ProviderLogo.svelte';
	import Glyph from './Glyph.svelte';

	const {
		provider,
		icon,
		icon_props,
		show_name,
		fallback_attrs,
		fallback,
		children,
		...rest
	}: SvelteHTMLElements['a'] & {
		provider: Provider | null | undefined;
		icon?: 'glyph' | 'svg' | Snippet<[provider: Provider, glyph: string]> | undefined;
		icon_props?: Record<string, any> | undefined;
		show_name?: boolean | undefined;
		fallback_attrs?: SvelteHTMLElements['span'] | undefined;
		fallback?: Snippet | undefined;
	} = $props();

	if (icon && children) {
		console.error('icon and children are mutually exclusive');
	}
	if (fallback && fallback_attrs) {
		console.error('fallback and fallback_attrs are mutually exclusive');
	}

	const selected = $derived(
		!!provider && page.url.pathname === resolve(`/providers/${provider.name}`),
	);
</script>

<!-- whitespace is a part tricky here, we want none with glyphs -->
{#if provider}
	<a {...rest} href={resolve(`/providers/${provider.name}`)} class:selected
		>{#if children}
			{@render children()}
		{:else}
			{#if icon === 'glyph'}
				<Glyph glyph={GLYPH_PROVIDER} />
			{:else if icon === 'svg'}
				<ProviderLogo name={provider.name} {...icon_props} />&nbsp;
			{:else if icon}
				{@render icon(provider, GLYPH_PROVIDER)}
			{/if}{#if show_name}
				{provider.name}
			{:else}
				{provider.title}
			{/if}
		{/if}</a
	>
{:else if fallback}
	{@render fallback()}
{:else}
	<small {...fallback_attrs} class="font_family_mono color_c_50 {fallback_attrs?.class}"
		><Glyph glyph={GLYPH_PROVIDER} /> missing provider</small
	>
{/if}

<style>
	a {
		font-weight: 600;
	}
	/* TODO breaks convention, but I think it looks better in a lot of cases, maybe extract a class? `plain_selected_link` or `plain`? */
	.selected {
		font-weight: 400;
		text-decoration: none;
	}
</style>

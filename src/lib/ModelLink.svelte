<script lang="ts">
	import type {Snippet} from 'svelte';
	import {page} from '$app/state';
	import {resolve} from '$app/paths';
	import type {SvelteHTMLElements} from 'svelte/elements';

	import type {Model} from './model.svelte.js';
	import ProviderLogo from './ProviderLogo.svelte';
	import {GLYPH_MODEL} from './glyphs.js';
	import Glyph from './Glyph.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';

	const {
		model,
		icon,
		name,
		children,
		...rest
	}: SvelteHTMLElements['a'] & {
		model: Model;
		/**
		 * `true` is equivalent to `'svg'`
		 */
		icon?: boolean | 'svg' | 'glyph' | undefined;
		name?: Snippet | undefined;
	} = $props();

	const selected = $derived(page.url.pathname === resolve(`/models/${model.name}`));
</script>

<!-- TODO this contextmenu appears as a duplicate, I think a de-duped key is the best fix, not manually disabling it -->
<ModelContextmenu {model}
	><a {...rest} href={resolve(`/models/${model.name}`)} class="selected-plain" class:selected
		>{#if children}
			{@render children()}
		{:else}
			{#if icon === 'svg' || icon === true}
				<ProviderLogo name={model.provider_name} />
			{:else if icon === 'glyph'}
				<Glyph glyph={GLYPH_MODEL} />
			{/if}
			{#if name}{@render name()}{:else}{model.name}{/if}
		{/if}</a
	></ModelContextmenu
>

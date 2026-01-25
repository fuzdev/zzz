<script lang="ts">
	import {page} from '$app/state';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {Snippet} from 'svelte';
	import {resolve} from '$app/paths';
	import {strip_end} from '@fuzdev/fuz_util/string.js';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	const {
		href,
		selected: selected_prop,
		show_selected_descendent = true,
		children,
		...rest
	}: OmitStrict<SvelteHTMLElements['a'], 'children'> & {
		href: string;
		selected?: boolean | undefined;
		show_selected_descendent?: boolean | undefined;
		children: Snippet<[selected: boolean, selected_descendent: boolean]>;
	} = $props();

	const href_normalized = $derived(strip_end(href, '/'));
	const pathname_normalized = $derived(strip_end(page.url.pathname, '/'));

	const selected = $derived(selected_prop ?? pathname_normalized === href_normalized);
	const selected_descendent = $derived(
		show_selected_descendent &&
			(selected || href_normalized === resolve('/')
				? false
				: (pathname_normalized + '/').startsWith(href + '/')),
	);

	// TODO link styles should have focus always be blue, and active should be thicker
</script>

<!-- 
	transition:slide -->
<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a {...rest} {href} class="nav_link {rest.class}" class:selected class:selected_descendent
	>{@render children(selected, selected_descendent)}</a
>

<style>
	.nav_link {
		display: flex;
		align-items: center;
		padding: var(--space_xs2) var(--space_sm);
		text-decoration: none;
		border: var(--border_width_2) var(--border_style) transparent;
		color: var(--text_80);
		font-weight: 600;
		white-space: nowrap;
	}
	.nav_link:hover {
		border-color: var(--border_color_50);
	}
	.nav_link:active {
		border-color: var(--color_a_50);
	}
	.nav_link.selected {
		border-color: var(--color_a_50);
		color: var(--color_a_60);
	}
	.nav_link.selected_descendent {
		border-color: var(--border_color_50);
	}
</style>

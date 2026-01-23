<script lang="ts" module>
	// TODO refactor
	const github_regex = /^https:\/\/(?:[\w-]+\.)*github\.com\//;
	const openai_regex = /^https:\/\/(?:[\w-]+\.)*(chatgpt\.com|openai\.com)\//;
	const anthropic_regex = /^https:\/\/(?:[\w-]+\.)*(claude\.ai|anthropic\.com)\//;
	const google_regex = /^https:\/\/(?:[\w-]+\.)*(google\.com|google\.dev)\//;
</script>

<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {Snippet} from 'svelte';
	import {logo_github} from '@fuzdev/fuz_ui/logos.js';
	import Svg, {type SvgData} from '@fuzdev/fuz_ui/Svg.svelte';

	import {logo_chatgpt, logo_claude, logo_gemini} from './logos.js';
	import ExternalLinkIcon from './ExternalLinkIcon.svelte';

	// TODO maybe make this `Link` and infer optional prop `external`?

	const {
		href,
		new_tab = true,
		icon,
		children,
		...rest
	}: SvelteHTMLElements['a'] & {
		href: string;
		/** Set to false to open in the same tab. */
		new_tab?: boolean | undefined;
		icon?: Snippet<[known_logo: SvgData | null]> | undefined;
	} = $props();

	const known_logo: SvgData | null = $derived(
		github_regex.test(href)
			? logo_github
			: openai_regex.test(href)
				? logo_chatgpt
				: anthropic_regex.test(href)
					? logo_claude
					: google_regex.test(href)
						? logo_gemini
						: null,
	);

	const rel: string = $derived.by(() => {
		const parts: Array<string> = [];
		if (!rest.rel?.includes('external')) parts.push('external');
		if (new_tab) parts.push('noopener');
		if (rest.rel) parts.push(rest.rel);
		return parts.join(' ');
	});
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -->
<a
	{...rest}
	{href}
	target={new_tab ? (rest.target ?? '_blank') : rest.target}
	{rel}
	class:color_i_5={true}
	>{#if children}{@render children()}{:else}{href}{/if}<ExternalLinkIcon
		>{#snippet children(text_icon)}{#if icon}{@render icon(known_logo)}{:else if known_logo}<Svg
					data={known_logo}
					size="var(--font_size_xs)"
					fill="var(--color_i_50)"
					inline
				/>{:else}{text_icon}{/if}{/snippet}</ExternalLinkIcon
	></a
>

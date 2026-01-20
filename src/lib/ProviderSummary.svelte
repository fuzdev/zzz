<script lang="ts">
	import {resolve} from '$app/paths';
	import {page} from '$app/state';
	import type {SvelteHTMLElements} from 'svelte/elements';

	import type {Provider} from './provider.svelte.js';
	import ModelSummary from './ModelSummary.svelte';
	import ExternalLink from './ExternalLink.svelte';

	const {
		provider,
		attrs,
	}: {
		provider: Provider;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	const at_detail_page = $derived(page.url.pathname === resolve(`/providers/${provider.name}`));
</script>

<div {...attrs} class="panel p_lg {attrs?.class}">
	{#if at_detail_page}
		<h1>
			{provider.title}
		</h1>
	{:else}
		<h2>
			<ExternalLink href={provider.url}>{provider.title}</ExternalLink>
		</h2>
	{/if}
	<section>
		<div class="mb_md font_family_mono">{provider.name}</div>
		<div>
			<ExternalLink href={provider.url}>docs</ExternalLink>
		</div>
	</section>
	<ul class="display:flex flex-wrap:wrap unstyled gap_md">
		{#each provider.models as model (model)}
			<ModelSummary {model} />
		{/each}
	</ul>
</div>

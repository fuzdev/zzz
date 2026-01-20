<script lang="ts">
	import {resolve} from '$app/paths';
	import {page} from '$app/state';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {format_url} from '@fuzdev/fuz_util/url.js';

	import type {Provider} from './provider.svelte.js';
	import ProviderLogo from './ProviderLogo.svelte';
	import {GLYPH_PROVIDER} from './glyphs.js';
	import ExternalLink from './ExternalLink.svelte';
	import Glyph from './Glyph.svelte';
	import OllamaManager from './OllamaManager.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import ModelSummary from './ModelSummary.svelte';
	import CapabilityProviderApi from './CapabilityProviderApi.svelte';

	const {
		provider,
		attrs,
	}: {
		provider: Provider;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	const at_detail_page = $derived(page.url.pathname === resolve(`/providers/${provider.name}`));

	const app = frontend_context.get();

	// TODO @many get and display Ollama version, JS API client doesnt have it but the REST API does
	// maybe at `<Glyph glyph={GLYPH_PROVIDER} />{provider.name}`
</script>

<div {...attrs} class="panel p_lg {attrs?.class}">
	<section class="display:flex mb_lg">
		<div class="display:flex">
			<ProviderLogo name={provider.name} size="var(--icon_size_xl)" fill={null} />
			<div class="pl_xl">
				{#if at_detail_page}
					<h1 class="mb_md">
						{provider.title}
					</h1>
				{:else}
					<h2 class="mb_md">
						<ExternalLink href={provider.url}>{provider.title}</ExternalLink>
					</h2>
				{/if}
				<p class="mb_md">{provider.company}</p>
				<p class="mb_md">
					<Glyph glyph={GLYPH_PROVIDER} />{provider.name}
				</p>
				<div class="row gap_xl">
					<ExternalLink href={provider.homepage}>{format_url(provider.homepage)}</ExternalLink>
					<ExternalLink href={provider.url}>docs</ExternalLink>
				</div>
			</div>
		</div>
	</section>

	<section>
		{#if provider.name === 'ollama'}
			<OllamaManager ollama={app.ollama} />
		{:else}
			<div class="width_atmost_md mb_lg">
				<CapabilityProviderApi provider_name={provider.name} show_info={false} />
				{#if provider.api_key_url}
					<ExternalLink href={provider.api_key_url}>get API key</ExternalLink>
				{/if}
			</div>
		{/if}
	</section>

	<section>
		<aside>⚠️ This information is incomplete and may be incorrect or outdated.</aside>
		<ul class="display:flex flex-wrap:wrap unstyled gap_md">
			{#each provider.models as model (model)}
				<ModelSummary {model} omit_provider />
			{/each}
		</ul>
		<!-- TODO UI to add models -->
	</section>
</div>

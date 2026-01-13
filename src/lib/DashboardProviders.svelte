<script lang="ts">
	import {format_url} from '@fuzdev/fuz_util/url.js';

	import ProviderLink from './ProviderLink.svelte';
	import ModelLink from './ModelLink.svelte';
	import Glyph from './Glyph.svelte';
	import {GLYPH_CHECKMARK, GLYPH_ERROR, GLYPH_PROVIDER} from './glyphs.js';
	import {frontend_context} from './frontend.svelte.js';
	import ExternalLink from './ExternalLink.svelte';
	import ProviderLogo from './ProviderLogo.svelte';

	const app = frontend_context.get();
</script>

<div class="p_lg">
	<h1><Glyph glyph={GLYPH_PROVIDER} /> providers</h1>
	<aside>⚠️ This information is incomplete and may be incorrect or outdated.</aside>
	<div class="providers_grid">
		{#each app.providers.items as provider (provider)}
			<div class="panel p_lg align-self:start">
				<div class="font_size_xl mb_lg">
					<ProviderLink {provider} icon="svg" />
				</div>
				<p>
					<Glyph glyph={GLYPH_PROVIDER} />{provider.name}
					{#if provider.available}
						<span class="color_b_5 ml_sm"><Glyph glyph={GLYPH_CHECKMARK} /> available</span>
					{:else}
						<span class="color_c_5 ml_sm"
							><Glyph glyph={GLYPH_ERROR} />
							{provider.status && !provider.status.available
								? provider.status.error
								: 'unavailable'}</span
						>
					{/if}
				</p>
				<p>
					{#if provider.api_key_url}
						<ExternalLink href={provider.api_key_url}>get API key</ExternalLink>
					{/if}
				</p>
				<p>
					{#if provider.homepage}
						<ExternalLink href={provider.homepage}>{format_url(provider.homepage)}</ExternalLink>
					{/if}
				</p>
				<p>
					{#if provider.url}
						<ExternalLink href={provider.url}>docs</ExternalLink>
					{/if}
				</p>
				<ul class="unstyled">
					{#each provider.models as model (model)}
						<li class="row">
							<ModelLink class="font_family_mono width:100% row px_xs py_xs3 font_size_md" {model}>
								<div class="flex:1">
									<ProviderLogo name={model.provider_name} />
									<span>{model.name}</span>
								</div>
								{#if model.provider_name === 'ollama'}<Glyph
										glyph={model.downloaded ? GLYPH_CHECKMARK : ' '}
										title={model.downloaded ? 'downloaded' : 'not downloaded'}
									/>{/if}
							</ModelLink>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
</div>

<style>
	.providers_grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--space_lg);
		width: 100%;
	}
</style>

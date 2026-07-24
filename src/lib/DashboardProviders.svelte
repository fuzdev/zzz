<script lang="ts">
	import { format_url } from '@fuzdev/fuz_util/url.ts';

	import ProviderLink from './ProviderLink.svelte';
	import ModelLink from './ModelLink.svelte';
	import { icon_checkmark, icon_error, icon_provider } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import ExternalLink from './ExternalLink.svelte';
	import ProviderLogo from './ProviderLogo.svelte';

	const app = frontend_context.get();
</script>

<div class="p_lg">
	<h1><Svg data={icon_provider} /> providers</h1>
	<aside>⚠️ This information is incomplete and may be incorrect or outdated.</aside>
	<div class="providers-grid">
		{#each app.providers.items as provider (provider)}
			<div class="panel p_lg align-self:start">
				<div class="font_size_xl mb_lg">
					<ProviderLink {provider} icon="logo" />
				</div>
				<p>
					<Svg data={icon_provider} />
					{provider.name}
					{#if provider.available}
						<span class="palette_b_50 ml_sm"><Svg data={icon_checkmark} /> available</span>
					{:else}
						<span class="palette_c_50 ml_sm">
							<Svg data={icon_error} />
							{provider.status && !provider.status.available
								? provider.status.error
								: 'unavailable'}
						</span>
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
							</ModelLink>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
</div>

<style>
	.providers-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--space_lg);
		width: 100%;
	}
</style>

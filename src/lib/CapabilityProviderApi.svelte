<script lang="ts">
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import { onMount } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import ProviderLink from './ProviderLink.svelte';
	import { icon_provider } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import ExternalLink from './ExternalLink.svelte';

	const {
		provider_name,
		show_info = true
	}: {
		provider_name: 'claude' | 'chatgpt' | 'gemini';
		show_info?: boolean;
	} = $props();

	const app = frontend_context.get();
	const { capabilities } = app;

	const capability = $derived(capabilities.providers[provider_name]);
	const provider = $derived(app.providers.find_by_name(provider_name));

	let checking = $state.raw(false);

	// Provider keys come from the server's environment, not the browser — see
	// the `env_var_name` note below. This component reads status only.
	const env_var_name = $derived(
		provider_name === 'claude'
			? 'SECRET_ANTHROPIC_API_KEY'
			: provider_name === 'chatgpt'
				? 'SECRET_OPENAI_API_KEY'
				: 'SECRET_GOOGLE_API_KEY'
	);

	// the provider check is skipped until a ping has shown the backend is up
	onMount(async () => {
		await capabilities.init_backend_check();
		await capabilities.providers[provider_name].init_check();
	});

	// a failed reload, shown until the provider status refreshes some other way
	let reload_failure: { message: string; updated: number | null } | null = $state.raw(null);
	const reload_error = $derived.by(() =>
		reload_failure?.updated === capability.updated ? reload_failure.message : null
	);

	const reload_status = async () => {
		checking = true;
		reload_failure = null;
		const result = await app.api.provider_load_status({ provider_name });
		checking = false;
		if (!result.ok) reload_failure = { message: result.error.message, updated: capability.updated };
	};
</script>

<div class="display:flex flex-direction:column">
	{#if provider}
		<div class="py_sm display:flex gap_sm align-items:start">
			<form class="flex:1">
				<div
					class="width:100% chip plain flex:1 flex-direction:column mb_lg"
					style:display="display:flex !important"
					style:align-items="flex-start !important"
					style:font-weight="400 !important"
					class:palette_b={capability.status === 'success'}
					class:palette_c={capability.status === 'failure'}
					class:palette_d={capability.status === 'pending' || checking}
					class:palette_e={capability.status === 'initial'}
				>
					<div class="column justify-content:center gap_xs pl_md" style:min-height="80px">
						<div class="font_size_xl">
							{provider.name}
							{capability.status === 'success'
								? 'configured'
								: capability.status === 'failure'
									? 'not configured'
									: capability.status === 'pending' || checking
										? 'checking'
										: 'not checked'}
							{#if capability.status === 'pending' || checking}
								<PendingAnimation inline />
							{/if}
						</div>
						<span class="font_family_mono font_size_sm">
							{#if reload_error}
								failed to reload: {reload_error}
							{:else if capability.error_message}
								{capability.error_message}
							{:else if capability.status === 'success'}
								available
							{:else if !capabilities.backend_available}
								backend unavailable
							{:else}
								&nbsp;
							{/if}
						</span>
					</div>
				</div>
				<!-- TODO add actual API connection test (make minimal API call to verify key works) -->
				<fieldset>
					<p class="font_size_sm">
						set <code>{env_var_name}</code> in the server's environment and restart
					</p>
					<div class="display:flex justify-content:space-between gap_xs">
						<button type="button" class="flex:1" disabled={checking} onclick={reload_status}>
							reload
						</button>
					</div>
				</fieldset>
			</form>

			<div class="flex:1">
				{#if show_info}
					<div>
						<ProviderLink {provider}>
							<span class="white-space:nowrap">
								<Icon data={icon_provider} />
								{provider.title}
							</span> provider
						</ProviderLink>
					</div>
					<ul>
						{#if provider.api_key_url}
							<li>
								<ExternalLink href={provider.api_key_url}>get API key</ExternalLink>
							</li>
						{/if}
						<li>
							<ExternalLink href={provider.homepage}>homepage</ExternalLink>
						</li>
						<li>
							<ExternalLink href={provider.url}>docs</ExternalLink>
						</li>
					</ul>
				{/if}
			</div>
		</div>
	{:else}
		<div class="py_sm">
			<ErrorMessage>
				<small class="font_family_mono">provider "{provider_name}" not found</small>
			</ErrorMessage>
		</div>
	{/if}
</div>

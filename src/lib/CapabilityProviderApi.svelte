<script lang="ts">
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {onMount} from 'svelte';

	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import {GLYPH_PROVIDER} from './glyphs.js';
	import ErrorMessage from './ErrorMessage.svelte';
	import ExternalLink from './ExternalLink.svelte';

	const {
		provider_name,
		show_info = true,
	}: {
		provider_name: 'claude' | 'chatgpt' | 'gemini';
		show_info?: boolean;
	} = $props();

	const app = frontend_context.get();
	const {capabilities} = app;

	const capability = $derived(capabilities[provider_name]);
	const provider = $derived(app.providers.find_by_name(provider_name));

	let api_key_input = $state('');
	let updating = $state(false);
	let checking = $state(false);

	const api_key_input_normalized = $derived(api_key_input.trim());

	onMount(() => {
		// TODO use a unified method
		void capabilities[`init_${provider_name}_check` as const]();
	});

	const update_api_key = async () => {
		if (!api_key_input_normalized) return;

		updating = true;
		try {
			await app.api.provider_update_api_key({
				provider_name,
				api_key: api_key_input_normalized,
			});
			api_key_input = '';
		} catch (error) {
			console.error(`Failed to update ${provider_name} API key:`, error);
		} finally {
			updating = false;
		}
	};

	const delete_api_key = async () => {
		updating = true;
		try {
			await app.api.provider_update_api_key({
				provider_name,
				api_key: '',
			});
		} catch (error) {
			console.error(`Failed to delete ${provider_name} API key:`, error);
		} finally {
			updating = false;
		}
	};

	const reload_status = async () => {
		checking = true;
		try {
			await app.api.provider_load_status({provider_name});
		} catch (error) {
			console.error(`Failed to check ${provider_name} connection:`, error);
		} finally {
			checking = false;
		}
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
					class:color_b={capability.status === 'success'}
					class:color_c={capability.status === 'failure'}
					class:color_d={capability.status === 'pending' || checking}
					class:color_e={capability.status === 'initial'}
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
							{#if capability.error_message}
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
					<input
						type="password"
						bind:value={api_key_input}
						placeholder="enter new API key"
						class="mb_sm"
						disabled={updating || !capabilities.backend_available}
					/>
					<div class="display:flex justify-content:space-between gap_xs">
						<button
							type="button"
							class="flex:1"
							disabled={!api_key_input_normalized || updating || !capabilities.backend_available}
							onclick={update_api_key}
						>
							{#if updating}
								updating <PendingAnimation inline />
							{:else}
								update key
							{/if}
						</button>
						<button
							type="button"
							class="flex:1"
							disabled={checking || updating || !capabilities.backend_available}
							onclick={reload_status}
						>
							reload
						</button>
						<button
							type="button"
							class="flex:1"
							disabled={capability.status !== 'success' ||
								updating ||
								!capabilities.backend_available}
							onclick={delete_api_key}
						>
							delete key
						</button>
					</div>
				</fieldset>
			</form>

			<div class="flex:1">
				{#if show_info}
					<div>
						<ProviderLink {provider}
							><span class="white-space:nowrap"
								><Glyph glyph={GLYPH_PROVIDER} />
								{provider.title}</span
							> provider</ProviderLink
						>
					</div>
					<ul>
						<li>
							<ExternalLink href={provider.api_key_url!}>get API key</ExternalLink>
						</li>
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
			<ErrorMessage
				><small class="font_family_mono">provider "{provider_name}" not found</small></ErrorMessage
			>
		</div>
	{/if}
</div>

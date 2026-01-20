<script lang="ts">
	// @slop Claude Sonnet 3.7

	import {slide} from 'svelte/transition';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {onMount} from 'svelte';
	import {plural} from '@fuzdev/fuz_util/string.js';

	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import ModelLink from './ModelLink.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import {GLYPH_ARROW_RIGHT, GLYPH_MODEL, GLYPH_PROVIDER} from './glyphs.js';
	import ErrorMessage from './ErrorMessage.svelte';
	import ExternalLink from './ExternalLink.svelte';
	import OllamaPsStatus from './OllamaPsStatus.svelte';

	const app = frontend_context.get();
	const {capabilities, ollama} = app;

	let checking = $state(false);

	onMount(() => {
		void capabilities.init_ollama_check();

		// TODO @many probably want a different state to capture user intent of enabling polling, but the whole UX may change
		// Start polling for `ps` status if not already started
		const started_polling = !ollama.ps_polling_enabled;
		if (started_polling) {
			ollama.start_ps_polling({immediate: capabilities.ollama.status !== 'initial'}); // may be refreshed in `init_ollama_check`
		}

		return started_polling
			? () => {
					ollama.stop_ps_polling();
				}
			: undefined;
	});

	const reload_status = async () => {
		checking = true;
		try {
			await capabilities.check_ollama();
		} catch (error) {
			console.error('Failed to check ollama connection:', error);
		} finally {
			checking = false;
		}
	};
</script>

<div class="display:flex flex-direction:column">
	<div class="py_sm display:flex gap_sm align-items:start">
		<form class="flex:1">
			<div
				class="width:100% chip plain flex:1 flex-direction:column mb_lg"
				style:display="display:flex !important"
				style:align-items="flex-start !important"
				style:font-weight="400 !important"
				class:color_b={capabilities.ollama.status === 'success'}
				class:color_c={capabilities.ollama.status === 'failure'}
				class:color_d={capabilities.ollama.status === 'pending' || checking}
				class:color_e={capabilities.ollama.status === 'initial'}
			>
				<div class="column justify-content:center gap_xs pl_md" style:min-height="80px">
					<div class="font_size_xl">
						ollama {capabilities.ollama.status === 'success'
							? 'available'
							: capabilities.ollama.status === 'failure'
								? 'unavailable'
								: capabilities.ollama.status === 'pending' || checking
									? 'checking'
									: 'not checked'}
						{#if capabilities.ollama.status === 'pending' || checking}
							<PendingAnimation inline />
						{/if}
					</div>
					<span class="font_family_mono font_size_sm">
						{#if capabilities.ollama.error_message}
							{capabilities.ollama.error_message}
						{:else if !capabilities.backend_available}
							backend unavailable
						{:else}
							{ollama.host}
							{#if capabilities.ollama.data?.round_trip_time}<span
									><Glyph glyph={GLYPH_ARROW_RIGHT} />
									{Math.round(capabilities.ollama.data.round_trip_time)}ms</span
								>{/if}
						{/if}
					</span>
				</div>
			</div>
			<button
				type="button"
				class:color_a={capabilities.ollama.status === 'initial'}
				style:width="33%"
				disabled={checking || !capabilities.backend_available}
				onclick={reload_status}
			>
				reload
			</button>
		</form>

		<div class="flex:1 px_md">
			Ollama (<ExternalLink href="https://ollama.com/">ollama.com</ExternalLink>,
			<ExternalLink href="https://github.com/ollama/ollama">GitHub</ExternalLink>) is a local model
			server that forks
			<ExternalLink href="https://github.com/ggml-org/llama.cpp">llama.cpp</ExternalLink>. It's one
			of Zzz's first integrations and the plan is to support many other local LLM backends
			(input/feedback is welcome). See also the <ProviderLink
				provider={app.providers.find_by_name('ollama')}
				><span class="white-space:nowrap"><Glyph glyph={GLYPH_PROVIDER} /> Ollama</span> provider</ProviderLink
			> page.
		</div>
	</div>

	{#if capabilities.ollama.error_message}
		<div class="py_sm" transition:slide>
			<ErrorMessage
				><small class="font_family_mono">{capabilities.ollama.error_message}</small></ErrorMessage
			>
		</div>
	{/if}

	<!-- Running models status -->
	{#if capabilities.ollama.status === 'success'}
		<div transition:slide class="py_sm">
			<OllamaPsStatus {ollama} />
		</div>
	{/if}

	<!-- Models list -->
	{#if capabilities.ollama.status !== 'initial' && capabilities.ollama_models.length > 0}
		<div transition:slide class="py_sm">
			<div class="panel p_md">
				<h4 class="mt_0 mb_sm">
					<Glyph glyph={GLYPH_MODEL} />
					{capabilities.ollama_models.length} model{plural(capabilities.ollama_models.length)} installed
					locally
				</h4>
				<ul class="unstyled">
					{#each capabilities.ollama_models as ollama_model (ollama_model.name)}
						{@const model = app.models.find_by_name(ollama_model.name)}
						<li class="p_xs">
							{#if model}<ModelLink {model} />{:else}{ollama_model.name}{/if}
							<div class="font_family_mono font_size_sm">{ollama_model.size} MB</div>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{:else if capabilities.ollama.status === 'success' && capabilities.ollama.data?.list_response?.models.length === 0}
		<div transition:slide class="py_sm">
			<div class="panel p_md">
				<p>no models found - for now you can install models using the Ollama CLI</p>
			</div>
		</div>
	{/if}

	<p>
		Full controls are on the <ProviderLink provider={app.providers.find_by_name('ollama')}
			><span class="white-space:nowrap"><Glyph glyph={GLYPH_PROVIDER} /> Ollama</span> provider</ProviderLink
		> page.
	</p>
</div>

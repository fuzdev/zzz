<script lang="ts">
	// @slop claude_sonnet_4

	import {slide} from 'svelte/transition';
	import {plural} from '@fuzdev/fuz_util/string.js';

	import Glyph from './Glyph.svelte';
	import {
		GLYPH_CONNECT,
		GLYPH_REFRESH,
		GLYPH_SETTINGS,
		GLYPH_PLACEHOLDER,
		GLYPH_ARROW_RIGHT,
		GLYPH_CLEAR,
	} from './glyphs.js';
	import ErrorMessage from './ErrorMessage.svelte';
	import OllamaActions from './OllamaActions.svelte';
	import OllamaPsStatus from './OllamaPsStatus.svelte';
	import type {Ollama} from './ollama.svelte.js';
	import {OLLAMA_URL} from './ollama_helpers.js';
	import {frontend_context} from './frontend.svelte.js';

	const {
		ollama,
		last_active_view,
		onshowpull,
		onback,
	}: {
		ollama: Ollama;
		last_active_view: string | null;
		onshowpull: () => void;
		onback?: () => void;
	} = $props();

	const app = frontend_context.get();
	const {capabilities} = app;

	// TODO maybe add to ollama.svelte.ts
	const models_with_details = $derived(ollama.models.filter((m) => m.ollama_show_response_loaded));
	const models_with_details_count = $derived(models_with_details.length);

	const error_message = $derived(capabilities.ollama.error_message);
</script>

<div class="panel p_md">
	<header class="display:flex justify-content:space-between align-items:center mb_md">
		<h3 class="mt_0 mb_0">
			<Glyph glyph={GLYPH_SETTINGS} /> configure
		</h3>
		{#if last_active_view && onback}
			<button
				type="button"
				class="icon_button plain"
				onclick={onback}
				title="back to {last_active_view}"
			>
				<Glyph glyph={GLYPH_ARROW_RIGHT} />
			</button>
		{/if}
	</header>

	<section class="width_atmost_md display:flex flex-direction:column gap_lg">
		<p>
			Ollama is a local LLM provider. {#if !error_message && capabilities.backend_available}
				Want to <button type="button" class="inline compact color_a" onclick={onshowpull}
					>pull a model</button
				>?{/if}
		</p>

		<div class="display:flex flex-direction:column gap_md">
			<fieldset>
				<label>
					<div class="title mb_xs">Ollama host url</div>
					<input
						type="text"
						class="plain flex:1"
						placeholder="{GLYPH_PLACEHOLDER} {OLLAMA_URL}"
						bind:value={ollama.host}
						oninput={() => ollama.refresh()}
					/>
				</label>
			</fieldset>

			<div class="row gap_xs justify-content:space-between">
				<button
					type="button"
					class="justify-content:start"
					disabled={ollama.list_status === 'pending' || !capabilities.backend_available}
					onclick={() => ollama.refresh()}
				>
					<Glyph glyph={ollama.list_status === 'success' ? GLYPH_REFRESH : GLYPH_CONNECT} />
					<span class="ml_sm">
						{#if ollama.list_status === 'pending'}
							checking...
						{:else}
							reload
						{/if}
					</span>
				</button>

				{#if ollama.host !== OLLAMA_URL}
					<div class="row gap_sm" transition:slide={{axis: 'x'}}>
						<button
							type="button"
							class="flex-shrink:0"
							onclick={async () => {
								ollama.host = OLLAMA_URL;
								await ollama.refresh();
							}}>reset to default</button
						>
						<small class="font_family_mono">
							{OLLAMA_URL}
						</small>
					</div>
				{/if}

				<div class="display:flex gap_sm">
					<button
						type="button"
						class="plain"
						onclick={() => ollama.clear_all_model_details()}
						title="clear all cached model details ({models_with_details_count} item{plural(
							models_with_details_count,
						)})"
						disabled={models_with_details_count === 0}
					>
						<Glyph glyph={GLYPH_CLEAR} />&nbsp; clear details cache {#if models_with_details_count}({models_with_details_count}){/if}
					</button>
				</div>
			</div>

			{#if error_message}
				<div transition:slide>
					<ErrorMessage><small class="font_family_mono">{error_message}</small></ErrorMessage>
				</div>
			{/if}
		</div>

		<OllamaPsStatus {ollama} />

		<OllamaActions {ollama} />
	</section>
</div>

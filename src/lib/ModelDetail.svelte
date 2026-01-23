<script lang="ts">
	// @slop Claude Sonnet 3.7

	import {resolve} from '$app/paths';
	import {page} from '$app/state';
	import type {SvelteHTMLElements} from 'svelte/elements';
	import {onMount} from 'svelte';

	import ModelLink from './ModelLink.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import type {Model} from './model.svelte.js';
	import {GLYPH_MODEL, GLYPH_CHECKMARK, GLYPH_ADD, GLYPH_XMARK, GLYPH_ERROR} from './glyphs.js';
	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import OllamaModelDetail from './OllamaModelDetail.svelte';

	const {
		model,
		attrs,
	}: {
		model: Model;
		attrs?: SvelteHTMLElements['span'] | undefined;
	} = $props();

	const app = frontend_context.get();

	onMount(async () => {
		// Auto-load details for Ollama models when viewing the page
		if (model.provider_name === 'ollama') {
			const provider_status = app.lookup_provider_status('ollama');
			if (!provider_status?.available) {
				return;
			}

			if (model.needs_ollama_details) {
				await app.api.ollama_show({model: model.name});
			}
		}
	});

	const at_detail_page = $derived(page.url.pathname === resolve(`/models/${model.name}`));

	// TODO get model metadata, probably both at build time and runtime for the best UX

	// TODO add custom models/providers, show in the UI when they're in a bad state
</script>

<ModelContextmenu tag="div" attrs={{class: 'panel p_lg', ...attrs}} {model}>
	<section class="row mb_xl3">
		<div class="glyph_container">
			<Glyph glyph={GLYPH_MODEL} size="var(--icon_size_xl)" />
		</div>
		<div class="pl_xl">
			{#if at_detail_page}
				<h1 class="mb_md">
					{model.name}
				</h1>
			{:else}
				<h2>
					<ModelLink {model} />
				</h2>
			{/if}
			<div class="ml_sm mb_md">
				<ProviderLink provider={model.provider} icon="svg" class="font_size_lg" />
				{#if model.provider && !model.provider.available}
					<span class="font_size_md color_c_50 ml_sm">
						<Glyph glyph={GLYPH_ERROR} />
						{model.provider.status && !model.provider.status.available
							? model.provider.status.error
							: 'unavailable'}
					</span>
				{/if}
			</div>
			{#if model.downloaded !== undefined}
				<div class="mb_lg">
					{#if model.downloaded}
						<Glyph glyph={GLYPH_CHECKMARK} />
					{:else}
						<Glyph glyph={GLYPH_XMARK} /> not
					{/if} downloaded
				</div>
			{/if}
			{#if model.tags.length}
				<ul class="unstyled display:flex gap_xs">
					{#each model.tags as tag (tag)}
						<small class="chip font-weight:400">{tag}</small>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	{#if model.provider_name === 'ollama'}
		<OllamaModelDetail
			{model}
			onshow={() => app.api.ollama_show({model: model.name})}
			ondelete={async (m) => {
				await app.ollama.delete(m.name);
			}}
		>
			{#snippet header()}{/snippet}
		</OllamaModelDetail>
	{:else}
		<aside class="mt_xl3 width_atmost_md">
			⚠️ This should show model info, but the APIs for ChatGPT and Claude do not provide metadata
			like context window size, output token limit, and other details. Gemini however does. It looks
			like we'll have to maintain hardcoded metadata for models, probably extending what we can
			retrieve from each API.
		</aside>
		<section class="display:flex gap_xs">
			<button
				type="button"
				class="color_d"
				onclick={() => app.chats.add(undefined, true).add_thread(model)}
			>
				<Glyph glyph={GLYPH_ADD} />&nbsp; create a new chat
			</button>
		</section>
		<!-- TODo do something like this when the warning above is addressed -->
		<!-- <section>
			<div>
				{#if model.context_window}
					<div>
						<strong>context window:</strong>
						{model.context_window.toLocaleString()} tokens
					</div>
				{/if}
				{#if model.output_token_limit}
					<div>
						<strong>output limit:</strong>
						{model.output_token_limit.toLocaleString()} tokens
					</div>
				{/if}
				{#if model.parameter_count}
					<div>
						<strong>parameters:</strong>
						{model.parameter_count.toLocaleString()}B
					</div>
				{/if}
				{#if model.filesize}
					<div>
						<strong>file size:</strong>
						{format_gigabytes(model.filesize)}
					</div>
				{/if}
				{#if model.architecture}
					<div>
						<strong>architecture:</strong>
						{model.architecture}
					</div>
				{/if}
				{#if model.embedding_length}
					<div>
						<strong>embedding length:</strong>
						{model.embedding_length.toLocaleString()}
					</div>
				{/if}
				{#if model.training_cutoff}
					<div>
						<strong>training cutoff:</strong>
						{model.training_cutoff}
					</div>
				{/if}

				{#if model.ollama_list_response_item?.details}
					{#if model.ollama_list_response_item.details.format}
						<div>
							<strong>format:</strong>
							{model.ollama_list_response_item.details.format}
						</div>
					{/if}
					{#if model.ollama_list_response_item.details.quantization_level}
						<div>
							<strong>quantization:</strong>
							{model.ollama_list_response_item.details.quantization_level}
						</div>
					{/if}
					{#if model.ollama_list_response_item.details.families.length}
						<div>
							<strong>families:</strong>
							{model.ollama_list_response_item.details.families.join(', ')}
						</div>
					{/if}
				{/if}
			</div>

			{#if model.cost_input || model.cost_output}
				<section>
					<h3>pricing</h3>
					{#if model.cost_input}
						<div><strong>input:</strong> ${model.cost_input.toFixed(2)} / 1M tokens</div>
					{/if}
					{#if model.cost_output}
						<div><strong>output:</strong> ${model.cost_output.toFixed(2)} / 1M tokens</div>
					{/if}
				</section>
			{/if}
		</section> -->
	{/if}
</ModelContextmenu>

<style>
	.glyph_container {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: var(--icon_size_xl);
		line-height: 1;
	}
</style>

<script lang="ts">
	// @slop claude_sonnet_4

	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import Details from '@fuzdev/fuz_ui/Details.svelte';
	import type {Snippet} from 'svelte';

	import Glyph from './Glyph.svelte';
	import {
		GLYPH_REFRESH,
		GLYPH_DELETE,
		GLYPH_ARROW_LEFT,
		GLYPH_ADD,
		GLYPH_DOWNLOAD,
		GLYPH_DISCONNECT,
	} from './glyphs.js';
	import type {Model} from './model.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import ModelLink from './ModelLink.svelte';
	import {format_short_date} from './time_helpers.js';
	import {format_gigabytes} from './format_helpers.js';

	const {
		model,
		onshow,
		onclose,
		ondelete,
		header,
	}: {
		model: Model;
		// TODO maybe dont include these args?
		onshow: (model: Model) => void;
		onclose?: (model: Model) => void;
		ondelete?: (model: Model) => void;
		header?: Snippet;
	} = $props();

	// TODO refactor with `ModelDetail`?
</script>

<ModelContextmenu {model}>
	{#if header}
		{@render header()}
	{:else}
		<header class="display:flex justify-content:space-between mb_md">
			<div class="display:flex flex-direction:column gap_xs">
				<h3 class="mt_0 mb_0 font_family_mono">
					<ModelLink {model} icon />
				</h3>
			</div>
			{#if onclose}
				<button
					type="button"
					class="icon_button plain"
					onclick={() => onclose(model)}
					title="close"
				>
					<Glyph glyph={GLYPH_ARROW_LEFT} />
				</button>
			{/if}
		</header>
	{/if}

	<section class="display:flex gap_sm mb_xl3">
		{#if model.downloaded}
			<button
				type="button"
				class="plain"
				onclick={() => model.app.chats.add(undefined, true).add_thread(model)}
			>
				<Glyph glyph={GLYPH_ADD} />&nbsp; create a new chat
			</button>

			<button
				type="button"
				class="plain"
				title="load model details"
				onclick={() => onshow(model)}
				disabled={model.needs_ollama_details ||
					!model.ollama_show_response_loaded ||
					model.ollama_show_response_loading}
			>
				<Glyph glyph={GLYPH_REFRESH} />&nbsp; reload details
			</button>

			<!-- TODO should show pending status -->
			<button
				type="button"
				class="plain"
				title="unload model from memory"
				onclick={() => model.app.ollama.unload(model.name)}
				disabled={!model.loaded}
			>
				<Glyph glyph={GLYPH_DISCONNECT} />&nbsp; unload
			</button>

			{#if ondelete}
				<ConfirmButton
					onconfirm={() => ondelete(model)}
					position="right"
					class="plain color_c"
					title="delete {model.name}"
				>
					<Glyph glyph={GLYPH_DELETE} />&nbsp; delete model

					{#snippet popover_content(popover)}
						<button
							type="button"
							class="color_c icon_button"
							title="confirm delete"
							onclick={() => {
								// TODO async confirmation
								ondelete(model);
								popover.hide();
							}}
						>
							<Glyph glyph={GLYPH_DELETE} />
						</button>
					{/snippet}
				</ConfirmButton>
			{/if}
		{:else}
			<button
				type="button"
				class="color_a"
				onclick={() => model.navigate_to_download()}
				title="download this model"
			>
				<Glyph glyph={GLYPH_DOWNLOAD} />&nbsp; download model
			</button>
		{/if}
	</section>

	{#if !model.downloaded}
		<section class="panel p_md">
			<p class="color_d font_size_sm mt_0 mb_0">not downloaded</p>
		</section>
	{:else if model.ollama_show_response_loading}
		<section class="display:flex gap_sm align-items:center">
			<PendingAnimation />
			<span class="font_size_sm">loading model details...</span>
		</section>
	{:else if model.ollama_show_response_error}
		<section class="display:flex flex-direction:column gap_sm">
			<div class="color_c font_size_sm">
				failed to load details: {model.ollama_show_response_error}
			</div>
			<button
				type="button"
				class="color_c icon_button plain"
				onclick={() => onshow(model)}
				title="retry loading details"
			>
				<Glyph glyph={GLYPH_REFRESH} />
			</button>
		</section>
	{:else if model.ollama_show_response}
		<section class="display:flex flex-direction:column gap_md">
			<!-- basic info -->
			{#if model.ollama_show_response.details}
				<div class="display:grid gap_sm" style:grid-template-columns="auto 1fr">
					<h5 class="my_0">capabilities:</h5>
					<span class="font_family_mono">
						{model.ollama_show_response.capabilities?.join(', ') || 'none'}
					</span>

					<h5 class="my_0">parameters:</h5>
					<span class="font_family_mono">
						{model.ollama_show_response.details.parameter_size}
					</span>

					{#if model.filesize}
						<h5 class="my_0">filesize:</h5>
						<span class="font_family_mono">{format_gigabytes(model.filesize)}</span>
					{/if}

					{#if model.ollama_modified_at}
						<h5 class="my_0">modified:</h5>
						<span class="font_family_mono">{format_short_date(model.ollama_modified_at)}</span>
					{/if}

					<h5 class="my_0">family:</h5>
					<span class="font_family_mono">{model.ollama_show_response.details.family}</span>

					<h5 class="my_0">quantization:</h5>
					<span class="font_family_mono">
						{model.ollama_show_response.details.quantization_level}
					</span>

					<h5 class="my_0">format:</h5>
					<span class="font_family_mono">{model.ollama_show_response.details.format}</span>

					{#if model.ollama_show_response.details.parent_model}
						<h5 class="my_0">parent:</h5>
						<span class="font_family_mono">{model.ollama_show_response.details.parent_model}</span>
					{/if}
				</div>
			{/if}

			<!-- model info -->
			{#if model.ollama_show_response.model_info && Object.keys(model.ollama_show_response.model_info).length > 0}
				<div>
					<h5>model info:</h5>
					<pre><code>{JSON.stringify(model.ollama_show_response.model_info, null, '\t')}</code
						></pre>
				</div>
			{/if}

			<!-- template -->
			{#if model.ollama_show_response.template}
				<div>
					<h5>template:</h5>
					<pre><code>{model.ollama_show_response.template}</code></pre>
				</div>
			{/if}

			<!-- parameters -->
			{#if model.ollama_show_response.parameters}
				<div>
					<h5>parameters:</h5>
					<pre><code>{model.ollama_show_response.parameters}</code></pre>
				</div>
			{/if}

			<!-- system -->
			{#if model.ollama_show_response.system}
				<div>
					<h5>system:</h5>
					<pre><code>{model.ollama_show_response.system}</code></pre>
				</div>
			{/if}

			<!-- license -->
			{#if model.ollama_show_response.license}
				<Details class="mt_xl3">
					{#snippet summary()}<h5 class="display:inline">license:</h5>{/snippet}
					<pre><code>{model.ollama_show_response.license}</code></pre>
				</Details>
			{/if}

			<!-- modelfile -->
			{#if model.ollama_show_response.modelfile}
				<Details class="mt_xl3">
					{#snippet summary()}<h5 class="display:inline">modelfile:</h5>{/snippet}
					<pre><code>{model.ollama_show_response.modelfile}</code></pre>
				</Details>
			{/if}
		</section>
	{/if}
</ModelContextmenu>

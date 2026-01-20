<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	import ModelLink from './ModelLink.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import type {Model} from './model.svelte.js';
	import Glyph from './Glyph.svelte';
	import ProviderLogo from './ProviderLogo.svelte';
	import {GLYPH_DOWNLOAD} from './glyphs.js';
	import {format_gigabytes} from './format_helpers.js';

	const {
		model,
		omit_provider,
		attrs,
	}: {
		model: Model;
		omit_provider?: boolean | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	// TODO maybe rename to ModelListitem, particularly if we add a `ModelList` for the parent usage
</script>

<ModelContextmenu {model}>
	<div {...attrs} class="panel p_lg {attrs?.class}">
		<div class="font_size_xl mb_lg">
			<ModelLink {model} icon class="row">
				<div class="flex-shrink:0">
					<ProviderLogo name={model.provider_name} />
				</div>
				<span class="pl_sm">{model.name}</span>
			</ModelLink>
		</div>
		{#if !omit_provider}
			<div class="mb_lg">
				<ProviderLink provider={model.provider} icon="glyph" show_name />
			</div>
		{/if}

		{#if model.tags.length}
			<ul class="unstyled display:flex flex-wrap:wrap gap_xs mb_md mt_sm">
				{#each model.tags as tag (tag)}
					<small class="chip font-weight:400">{tag}</small>
				{/each}
			</ul>
		{/if}

		{#if model.downloaded === false}
			{#if model.provider_name === 'ollama' && !model.downloaded}
				<button type="button" class="plain compact" onclick={() => model.navigate_to_download()}>
					<Glyph glyph={GLYPH_DOWNLOAD} />&nbsp; download
				</button>
			{/if}
		{/if}

		<div class="specs_grid">
			{#if model.context_window}
				<div class="spec_item">
					<span class="spec_label">context:</span>
					<span>{model.context_window.toLocaleString()} tokens</span>
				</div>
			{/if}
			{#if model.parameter_count}
				<div class="spec_item">
					<span class="spec_label">parameters:</span>
					<span>{model.parameter_count.toLocaleString()}B</span>
				</div>
			{/if}
			{#if model.filesize}
				<div class="spec_item">
					<span class="spec_label">size:</span>
					<span>{format_gigabytes(model.filesize)}</span>
				</div>
			{/if}
		</div>
	</div>
</ModelContextmenu>

<style>
	.specs_grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space_xs);
	}
	.spec_item {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space_xs);
		font-size: var(--font_size_sm);
	}
	.spec_label {
		color: var(--color_text_2);
		font-weight: 600;
	}
</style>

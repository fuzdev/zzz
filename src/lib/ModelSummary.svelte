<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	import {icon_provider} from '@fuzdev/fuz_ui/icons.js';

	import ModelLink from './ModelLink.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import type {Model} from './model.svelte.js';
	import ProviderLogo from './ProviderLogo.svelte';
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
			<ModelLink {model} class="row">
				<div class="flex-shrink:0">
					<ProviderLogo name={model.provider_name} />
				</div>
				<span class="pl_sm">{model.name}</span>
			</ModelLink>
		</div>
		{#if !omit_provider}
			<div class="mb_lg">
				<ProviderLink provider={model.provider} icon={icon_provider} label="name" />
			</div>
		{/if}

		{#if model.tags.length}
			<ul class="unstyled display:flex flex-wrap:wrap gap_xs mb_md mt_sm">
				{#each model.tags as tag (tag)}
					<small class="chip font-weight:400">{tag}</small>
				{/each}
			</ul>
		{/if}

		<div class="column gap_xs">
			{#if model.context_window}
				<div class="display:flex flex-wrap:wrap gap_xs font_size_sm">
					<span class="text_50 font-weight:600">context:</span>
					<span>{model.context_window.toLocaleString()} tokens</span>
				</div>
			{/if}
			{#if model.parameter_count}
				<div class="display:flex flex-wrap:wrap gap_xs font_size_sm">
					<span class="text_50 font-weight:600">parameters:</span>
					<span>{model.parameter_count.toLocaleString()}B</span>
				</div>
			{/if}
			{#if model.filesize}
				<div class="display:flex flex-wrap:wrap gap_xs font_size_sm">
					<span class="text_50 font-weight:600">size:</span>
					<span>{format_gigabytes(model.filesize)}</span>
				</div>
			{/if}
		</div>
	</div>
</ModelContextmenu>

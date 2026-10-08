<script lang="ts">
	import type { Model } from './model.svelte.ts';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import ProviderLogo from './ProviderLogo.svelte';

	const {
		model,
		show_tags
	}: {
		model: Model;
		show_tags?: boolean | undefined;
	} = $props();

	// TODO show something to show if it's local (probably not file size?)
</script>

<!-- `Contextmenu`'s element is `display: contents`, so the layout lives on an inner element -->
<ModelContextmenu tag="div" {model}>
	<div class="width:100% py_sm">
		<div class="font_size_md row">
			<ProviderLogo name={model.provider_name} size="var(--font_size_xl)" />
			<div class="pl_sm">
				<div>
					{model.name}
				</div>
				<small class="row justify-content:space-between">
					<span>{model.provider_name}</span
					>{#if model.context_window_formatted}
						<span>{model.context_window_formatted}</span>
					{/if}
				</small>
			</div>
		</div>

		{#if show_tags && model.tags.length}
			<ul class="unstyled display:flex flex-wrap:wrap gap_xs2">
				{#each model.tags as tag (tag)}
					<small class="chip font_size_sm font-weight:400">{tag}</small>
				{/each}
			</ul>
		{/if}
	</div>
</ModelContextmenu>

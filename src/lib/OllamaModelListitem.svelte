<script lang="ts">
	// @slop claude_sonnet_4

	import OllamaModelStatus from './OllamaModelStatus.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import {format_gigabytes} from './format_helpers.js';
	import type {Model} from './model.svelte.js';

	const {
		model,
		onclick = () => ollama.select(model),
	}: {
		model: Model;
		onclick?: () => void;
	} = $props();

	const {ollama} = $derived(model.app);

	// TODO move to model?

	const selected = $derived(
		ollama.manager_selected_view === 'model'
			? ollama.manager_selected_model?.id === model.id
			: ollama.manager_selected_view === 'pull'
				? ollama.pull_model_name === model.name
				: false,
	);
</script>

<ModelContextmenu {model}>
	<button
		type="button"
		class="menu_item selectable plain text-align:start p_sm border_radius_0 font-weight:400"
		class:selected
		{onclick}
	>
		<div class="display:flex flex-direction:column gap_xs width:100%">
			<div class="display:flex justify-content:space-between align-items:center">
				<div class="ellipsis font_size_lg">
					{model.name}
				</div>
				<OllamaModelStatus {model} {ollama} />
			</div>
			{#if model.filesize}
				<div class="font_size_sm">
					{format_gigabytes(model.filesize)}
				</div>
			{/if}
		</div>
	</button>
</ModelContextmenu>

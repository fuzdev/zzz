<script lang="ts">
	import type {Model} from './model.svelte.js';
	import {frontend_context} from './frontend.svelte.js';

	const app = frontend_context.get();

	let {
		models = app.models.ordered_by_name,
		selected_model,
	}: {
		selected_model: Model; // TODO get from context?
		models?: Array<Model> | undefined;
	} = $props();
</script>

<div class="row">
	<select bind:value={selected_model}>
		{#each models as model (model)}
			<option value={model}>{model.name}</option>
		{/each}
	</select>
</div>

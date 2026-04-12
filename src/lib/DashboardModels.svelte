<script lang="ts">
	import {GLYPH_MODEL} from './glyphs.js';
	import ModelSummary from './ModelSummary.svelte';
	import Glyph from './Glyph.svelte';
	import {frontend_context} from './frontend.svelte.js';

	const app = frontend_context.get();

	// TODO make this a table

	// TODO add search/filtering/sorting
</script>

<div class="p_lg">
	<h1><Glyph glyph={GLYPH_MODEL} /> models</h1>
	<aside>⚠️ This information is incomplete and may be incorrect or outdated.</aside>
	<div class="models-grid">
		{#each app.models.ordered_by_name as model (model)}
			<ModelSummary {model} />
		{/each}
	</div>
</div>

<style>
	.models-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--space_lg);
		width: 100%;
	}
</style>

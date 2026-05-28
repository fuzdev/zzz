<script lang="ts">
	import Alert from '@fuzdev/fuz_ui/Alert.svelte';
	import {resolve} from '$app/paths';

	import ModelDetail from '$lib/ModelDetail.svelte';
	import {frontend_context} from '$lib/frontend.svelte.js';

	const {params} = $props();

	const app = frontend_context.get();

	const model_name = $derived(params.slug);

	const model = $derived(app.models.find_by_name(model_name));

	// TODO @many consider namespacing under `/llms/`
</script>

<div class="p_sm">
	{#if model}
		<ModelDetail {model} />
	{:else}
		<Alert status="error">
			no model found with name "{model_name}", maybe
			<button
				type="button"
				class="inline color_f"
				onclick={() =>
					// TODO UI for choosing provider
					app.models.add({name: model_name, provider_name: 'claude'})}
			>
				create it
			</button>
			or see the <a href={resolve('/models')}>models</a> or
			<a href={resolve('/providers')}>providers</a>
		</Alert>
	{/if}
</div>

<script lang="ts">
	import Alert from '@fuzdev/fuz_ui/Alert.svelte';
	import { BROWSER } from 'esm-env';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import ProviderDetail from '$lib/ProviderDetail.svelte';
	import { frontend_context } from '$lib/frontend.svelte.ts';

	const { params } = $props();

	const app = frontend_context.get();

	const provider = $derived(app.providers.find_by_name(params.slug));

	// TODO @many consider namespacing under `/llms/`

	// TODO should you be able to create arbitrary providers from a name?
</script>

<div class="p_sm">
	{#if provider}
		<ProviderDetail {provider} />
	{:else if BROWSER}
		<Alert status="error">
			no provider found with name "{params.slug}"
		</Alert>
	{:else}
		<!-- for SSR - is the animation what we want? better than nothing? -->
		<PendingAnimation running />
	{/if}
</div>

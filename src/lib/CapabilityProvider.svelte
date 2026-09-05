<script lang="ts">
	import type { ProviderName } from './provider_types.ts';

	import CapabilityProviderApi from './CapabilityProviderApi.svelte';

	const {
		provider_name
	}: {
		provider_name: ProviderName;
	} = $props();
</script>

<CapabilityProviderApi {provider_name} />

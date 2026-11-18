<script lang="ts">
	// Test harness: a `Picker` over plain items, with a search input.
	import Picker from '#lib/Picker.svelte';

	const {
		items,
		onpick,
		windowed = false
	}: {
		items: Array<{ id: string }>;
		onpick: (item: { id: string } | undefined) => void;
		windowed?: boolean;
	} = $props();
</script>

<Picker {items} {onpick} {windowed} heading="pick one" search_text={(item) => item.id}>
	{#snippet children(item, pick)}
		<button type="button" class="listitem" onclick={() => pick(item)}>{item.id}</button>
	{/snippet}
</Picker>

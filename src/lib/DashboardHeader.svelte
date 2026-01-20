<script lang="ts">
	import type {Snippet} from 'svelte';

	const {
		header,
		children,
	}: {
		header: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class="display:flex">
	<header class="flex:1">
		{@render header()}
	</header>
	<div>
		{@render children()}
	</div>
</div>

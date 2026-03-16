<script lang="ts">
	import TerminalRunner from '$lib/TerminalRunner.svelte';
	import PageFooter from '$routes/PageFooter.svelte';
</script>

<div class="terminals_page">
	<header>
		<h1>Terminals</h1>
	</header>

	<TerminalRunner />
</div>

<PageFooter />

<style>
	.terminals_page {
		display: flex;
		flex-direction: column;
		height: calc(100vh - var(--layout_header_height, 48px) - var(--layout_footer_height, 48px));
		padding: var(--space_md);
		gap: var(--space_md);
	}
	.terminals_page header {
		flex-shrink: 0;
	}
</style>

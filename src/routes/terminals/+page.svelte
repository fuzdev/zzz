<script lang="ts">
	import TerminalRunner from '$lib/TerminalRunner.svelte';
	import PageFooter from '$routes/PageFooter.svelte';
</script>

<div class="terminals-page">
	<header>
		<h1>Terminals</h1>
	</header>

	<TerminalRunner />
</div>

<PageFooter />

<style>
	.terminals-page {
		display: flex;
		flex-direction: column;
		/* fills the dashboard's scroller; `PageFooter` follows below the fold */
		height: 100%;
		padding: var(--space_md);
		gap: var(--space_md);
	}
	.terminals-page header {
		flex-shrink: 0;
	}
</style>

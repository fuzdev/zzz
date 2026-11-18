<script lang="ts">
	import { app_context } from './app.svelte.ts';

	const {
		limit = 50
	}: {
		/** How many of the newest entries to show. */
		limit?: number | undefined;
	} = $props();

	const app = app_context.get();

	const recent_intents = $derived(app.recent_intents);

	/** Newest first. */
	const shown = $derived(recent_intents.entries.slice(-limit).reverse());

	const to_input_text = (input: unknown): string => {
		let text: string | undefined;
		try {
			text = JSON.stringify(input);
		} catch {
			text = undefined;
		}
		if (text === undefined) return '(not shown)';
		return text.length > 80 ? text.slice(0, 79) + '…' : text;
	};
</script>

<section>
	<header class="row gap_sm justify-content:space-between">
		<h2 class="mt_0 mb_0">recent intents</h2>
		<button
			type="button"
			class="sized_sm"
			onclick={() => recent_intents.clear()}
			disabled={!recent_intents.entries.length}
		>
			clear
		</button>
	</header>
	{#if shown.length}
		<ol class="unstyled">
			{#each shown as entry (entry.seq)}
				<li class:color_c_50={entry.outcome === 'failed'} title={entry.error ?? undefined}>
					<code>{entry.method}</code>
					<small>
						v{entry.version} · {entry.history}{#if entry.outcome === 'failed'}
							· failed
						{/if}
					</small>
					{#if entry.input !== undefined}
						<small class="display:block"><code>{to_input_text(entry.input)}</code></small>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p><small>no intents yet — the menus, tabs, and shortcuts call them</small></p>
	{/if}
</section>

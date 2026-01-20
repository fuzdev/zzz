<script lang="ts">
	// @slop claude_sonnet_4

	import Glyph from './Glyph.svelte';
	import OllamaActionItem from './OllamaActionItem.svelte';
	import {GLYPH_CLEAR} from './glyphs.js';
	import type {Ollama} from './ollama.svelte.js';

	const {
		ollama,
	}: {
		ollama: Ollama;
	} = $props();

	const clear_completed_actions = () => {
		const completed_action_ids = ollama.completed_actions.map((a) => a.id);
		ollama.app.actions.items.remove_many(completed_action_ids);
	};
</script>

<div class="panel p_md width_atmost_md">
	<div class="display:flex justify-content:space-between align-items:center mb_md">
		<h4 class="mt_0 mb_0">action history</h4>
		<div class="display:flex gap_xs align-items:center">
			<label class="display:flex gap_xs align-items:center mb_0">
				<input type="checkbox" class="compact" bind:checked={ollama.show_read_actions} />
				<small>show read actions</small>
			</label>
			<button
				type="button"
				class="icon_button plain"
				title="clear completed actions"
				onclick={clear_completed_actions}
				disabled={ollama.completed_actions.length === 0}
			>
				<Glyph glyph={GLYPH_CLEAR} />
			</button>
		</div>
	</div>

	{#if ollama.filtered_actions.length === 0}
		<p>
			<small
				>no action history{ollama.show_read_actions ? '' : ', showing only write actions'}</small
			>
		</p>
	{:else}
		<ul class="unstyled">
			{#each ollama.filtered_actions as action (action.id)}
				<OllamaActionItem {action} />
			{/each}
		</ul>
	{/if}
</div>

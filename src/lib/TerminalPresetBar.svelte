<script lang="ts">
	import type {TerminalPreset} from './terminal_preset.svelte.js';
	import {GLYPH_PLAY} from './glyphs.js';

	interface Props {
		presets: Array<TerminalPreset>;
		onrun: (preset: TerminalPreset) => void;
	}

	const {presets, onrun}: Props = $props();
</script>

{#if presets.length > 0}
	<div class="terminal_preset_bar">
		{#each presets as preset (preset.id)}
			<button type="button" onclick={() => onrun(preset)}>
				{GLYPH_PLAY} {preset.name || preset.command}
			</button>
		{/each}
	</div>
{/if}

<style>
	.terminal_preset_bar {
		display: flex;
		gap: var(--space_xs);
		flex-wrap: wrap;
	}
</style>

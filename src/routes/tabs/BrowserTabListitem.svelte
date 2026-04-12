<script lang="ts">
	import {swallow} from '@fuzdev/fuz_util/dom.js';

	import {GLYPH_REMOVE} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import type {BrowserTab} from '$routes/tabs/browser_tab.svelte.js';

	const {
		tab,
		index,
		onselect,
		onclose,
	}: {
		tab: BrowserTab;
		index: number;
		onselect: (index: number) => void;
		onclose: (index: number) => void;
	} = $props();
</script>

<!-- TODO the transition is janky because it resizes the content, instead it should just hide with overflow -->
<div class="browser-tab-container" class:selected={tab.selected}>
	<div
		role="button"
		tabindex="0"
		class="browser-tab-button border-radius:0 plain px_sm py_xs"
		class:selected={tab.selected}
		onclick={() => onselect(index)}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				swallow(e);
				onselect(index);
			}
		}}
		aria-label={`Tab ${tab.title}`}
		aria-pressed={tab.selected}
	>
		<div class="ellipsis font-weight:400 flex:1">
			<Glyph glyph="⎕" />
			<small class="ml_xs">{tab.title}</small>
		</div>
		<button
			type="button"
			class="tab-close-button plain icon-button sm border_radius_md ml_sm"
			onclick={(e) => {
				swallow(e);
				onclose(index);
			}}
			title="close tab"
			aria-label={`close tab ${tab.title}`}
		>
			<Glyph glyph={GLYPH_REMOVE} />
		</button>
	</div>
</div>

<style>
	.browser-tab-container {
		display: flex;
		align-items: center;
		min-width: 10rem;
		max-width: 30rem;
	}

	.browser-tab-button {
		flex: 1;
		display: flex;
		align-items: center;
		height: 100%;
		white-space: nowrap;
		overflow: hidden;
		width: 100%;
		cursor: pointer;
	}
	.browser-tab-button:hover {
		box-shadow: var(--shadow_inset_bottom_xs)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_30)),
				transparent
			);
	}
	.browser-tab-button:active {
		box-shadow: var(--shadow_inset_top_xs)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_30)),
				transparent
			);
	}
	.browser-tab-button.selected {
		color: var(--text_90);
		box-shadow: var(--shadow_inset_top_sm)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_40)),
				transparent
			);
	}
</style>

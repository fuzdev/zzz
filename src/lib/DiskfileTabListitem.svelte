<script lang="ts">
	import {swallow} from '@fuzdev/fuz_util/dom.js';

	import {GLYPH_REMOVE} from './glyphs.js';
	import type {DiskfileTab} from './diskfile_tab.svelte.js';
	import Glyph from './Glyph.svelte';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';

	const {
		tab,
		onselect,
		onclose,
		onopen,
	}: {
		tab: DiskfileTab;
		onselect: (tab: DiskfileTab) => void;
		onclose: (tab: DiskfileTab) => void;
		onopen: (tab: DiskfileTab) => void;
	} = $props();

	const diskfile = $derived(tab.diskfile);

	const path = $derived(diskfile?.path_relative ?? '[no diskfile found]'); // TODO ?
</script>

<DiskfileContextmenu {diskfile}>
	<div
		class="diskfile_tab_container"
		class:selected={tab.is_selected}
		class:preview={tab.is_preview}
	>
		<div
			role="button"
			tabindex="0"
			class="diskfile_tab_button border_radius_0 plain px_sm py_xs"
			class:selected={tab.is_selected}
			class:preview={tab.is_preview}
			onclick={(e) => {
				swallow(e);
				// If it's a preview tab and it's double-clicked, promote it to permanent
				if (tab.is_preview && e.detail === 2) {
					onopen(tab);
				} else {
					onselect(tab);
				}
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					swallow(e);
					onselect(tab);
				}
			}}
			aria-label={`Tab ${path}`}
			aria-pressed={tab.is_selected}
		>
			<div class="ellipsis font-weight:400 flex:1">
				<small class="ml_xs">{path}</small>
			</div>
			<button
				type="button"
				class="tab_close_button plain icon_button compact border_radius_md ml_sm"
				onclick={(e) => {
					swallow(e);
					onclose(tab);
				}}
				title="close tab"
				aria-label={`close tab ${path}`}
			>
				<Glyph glyph={GLYPH_REMOVE} />
			</button>
		</div>
	</div>
</DiskfileContextmenu>

<style>
	.diskfile_tab_container {
		display: flex;
		align-items: center;
		min-width: 10rem;
		max-width: 30rem;
	}

	.diskfile_tab_button {
		--tab_hover_shadow: var(--shadow_inset_bottom_xs)
			color-mix(in hsl, var(--shadow_color) var(--shadow_alpha, var(--shadow_alpha_1)), transparent);
		--tab_active_shadow: var(--shadow_inset_top_xs)
			color-mix(in hsl, var(--shadow_color) var(--shadow_alpha, var(--shadow_alpha_1)), transparent);
		--tab_preview_shadow: var(--shadow_bottom_sm)
			color-mix(in hsl, var(--shadow_color) var(--shadow_alpha, var(--shadow_alpha_2)), transparent);
		--tab_selected_shadow: var(--shadow_inset_top_sm)
			color-mix(in hsl, var(--shadow_color) var(--shadow_alpha, var(--shadow_alpha_2)), transparent);
		--tab_selected_preview_shadow: var(--shadow_inset_top_xs)
			color-mix(in hsl, var(--shadow_color) var(--shadow_alpha, var(--shadow_alpha_1)), transparent);
		flex: 1;
		display: flex;
		align-items: center;
		white-space: nowrap;
		overflow: hidden;
		width: 100%;
		cursor: pointer;
	}

	.diskfile_tab_button:hover {
		box-shadow: var(--tab_hover_shadow);
	}

	.diskfile_tab_button:active {
		box-shadow: var(--tab_active_shadow);
	}

	.diskfile_tab_button.selected {
		box-shadow: var(--tab_selected_shadow);
	}

	.diskfile_tab_button.preview {
		font-style: italic;
		box-shadow: var(--tab_preview_shadow);
	}
	.diskfile_tab_button.preview:hover {
		box-shadow: var(--tab_preview_shadow), var(--tab_hover_shadow);
	}
	.diskfile_tab_button.preview:active {
		box-shadow: var(--tab_preview_shadow), var(--tab_active_shadow);
	}
	.diskfile_tab_button.preview.selected {
		box-shadow: var(--tab_preview_shadow), var(--tab_selected_preview_shadow);
	}
</style>

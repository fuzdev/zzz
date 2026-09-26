<script lang="ts">
	import { swallow } from '@fuzdev/fuz_util/dom.ts';

	import { icon_remove } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import type { DiskfileTab } from './diskfile_tab.svelte.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';

	const {
		tab,
		onselect,
		onclose,
		onopen
	}: {
		tab: DiskfileTab;
		onselect: (tab: DiskfileTab) => void;
		onclose: (tab: DiskfileTab) => void;
		onopen: (tab: DiskfileTab) => void;
	} = $props();

	const diskfile = $derived(tab.diskfile);

	const path = $derived(diskfile?.path_relative ?? '[no diskfile found]'); // TODO ?
	const deleted_on_disk = $derived(diskfile?.deleted_on_disk ?? false);
</script>

<DiskfileContextmenu {diskfile}>
	<div
		class="diskfile-tab-container"
		class:selected={tab.is_selected}
		class:preview={tab.is_preview}
	>
		<div
			role="button"
			tabindex="0"
			class="diskfile-tab-button border-radius:0 plain px_sm py_xs"
			class:selected={tab.is_selected}
			class:preview={tab.is_preview}
			class:deleted={deleted_on_disk}
			title={deleted_on_disk ? `${path} — deleted on disk, has unsaved edits` : undefined}
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
				// leave keys on the nested close button alone — swallowing would cancel its click
				if (e.target !== e.currentTarget) return;
				if (e.key === 'Enter' || e.key === ' ') {
					swallow(e);
					onselect(tab);
				}
			}}
			aria-label={deleted_on_disk ? `Tab ${path} (deleted on disk)` : `Tab ${path}`}
			aria-pressed={tab.is_selected}
		>
			<div class="ellipsis font-weight:400 flex:1">
				<small class="ml_xs">{path}</small>
				{#if deleted_on_disk}<small class="ml_xs color_c_50">(deleted)</small>{/if}
			</div>
			<button
				type="button"
				class="tab-close-button plain icon-button sm border_radius_md ml_sm"
				onclick={(e) => {
					swallow(e);
					onclose(tab);
				}}
				title="close tab"
				aria-label={`close tab ${path}`}
			>
				<Svg data={icon_remove} />
			</button>
		</div>
	</div>
</DiskfileContextmenu>

<style>
	.diskfile-tab-container {
		display: flex;
		align-items: center;
		min-width: 10rem;
		max-width: 30rem;
	}

	.diskfile-tab-button {
		--tab_hover_shadow: var(--shadow_inset_bottom_xs)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_30)),
				transparent
			);
		--tab_active_shadow: var(--shadow_inset_top_xs)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_30)),
				transparent
			);
		--tab_preview_shadow: var(--shadow_bottom_sm)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_40)),
				transparent
			);
		--tab_selected_shadow: var(--shadow_inset_top_sm)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_40)),
				transparent
			);
		--tab_selected_preview_shadow: var(--shadow_inset_top_xs)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_30)),
				transparent
			);
		flex: 1;
		display: flex;
		align-items: center;
		white-space: nowrap;
		overflow: hidden;
		width: 100%;
		cursor: pointer;
	}

	.diskfile-tab-button:hover {
		box-shadow: var(--tab_hover_shadow);
	}

	.diskfile-tab-button:active {
		box-shadow: var(--tab_active_shadow);
	}

	.diskfile-tab-button.selected {
		box-shadow: var(--tab_selected_shadow);
	}

	.diskfile-tab-button.deleted small:first-child {
		text-decoration: line-through;
	}

	.diskfile-tab-button.preview {
		font-style: italic;
		box-shadow: var(--tab_preview_shadow);
	}
	.diskfile-tab-button.preview:hover {
		box-shadow: var(--tab_preview_shadow), var(--tab_hover_shadow);
	}
	.diskfile-tab-button.preview:active {
		box-shadow: var(--tab_preview_shadow), var(--tab_active_shadow);
	}
	.diskfile-tab-button.preview.selected {
		box-shadow: var(--tab_preview_shadow), var(--tab_selected_preview_shadow);
	}
</style>

<script lang="ts">
	// @slop Claude Opus 4

	import {swallow, is_editable} from '@fuzdev/fuz_util/dom.js';
	import type {Snippet} from 'svelte';

	import {
		icon_add,
		icon_arrow_left,
		icon_arrow_right,
		icon_drag,
		icon_refresh,
	} from '@fuzdev/fuz_ui/icons.js';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {GLYPH_PLACEHOLDER} from '$lib/glyphs.js';
	import type {Browser} from '$routes/tabs/browser.svelte.js';
	import BrowserTabContent from '$routes/tabs/BrowserTabContent.svelte';
	import BrowserTabListitem from '$routes/tabs/BrowserTabListitem.svelte';
	import {Reorderable} from '$lib/reorderable.svelte.js';

	const {
		browser,
		children,
	}: {
		browser: Browser;
		children: Snippet;
	} = $props();

	const tabs_reorderable = new Reorderable({item_class: null}); // remove the normal reorderable item styling
</script>

<svelte:window
	onkeydown={(e) => {
		if (is_editable(e.target)) {
			return;
		}

		// We can't override the actual browser keyboard shortcuts here, so we use `q` instead of `t`.
		// Keyboard shortcuts also don't work when an iframe is focused.
		// Both of these issues will be fixed in Zzz's eventual browser that'll run as a native app.

		// ctrl+q: New tab
		if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'q') {
			swallow(e);
			browser.add_new_tab();
		}

		// ctrl+shift+q: Reopen last closed tab
		if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
			swallow(e);
			browser.reopen_last_closed_tab();
		}

		// ctrl+alt+q: Close current tab
		if (e.ctrlKey && e.altKey && !e.shiftKey && e.key === 'q') {
			swallow(e);
			const index = browser.tabs.ordered_tabs.findIndex((t) => t.selected);
			if (index !== -1) {
				browser.close_tab(index);
			}
		}
		// TODO add other global keyboard shortcuts
	}}
/>

<div class="browser-container">
	<!-- browser chrome/header -->
	<div class="browser-chrome">
		<!-- tab bar -->
		<ul
			class="browser-tab-bar unstyled display:flex overflow-x:auto overflow-y:hidden scrollbar-width:thin"
			{@attach tabs_reorderable.list({
				onreorder: (from_index, to_index) => browser.reorder_tab(from_index, to_index),
			})}
		>
			{#each browser.tabs.ordered_tabs as tab, index (tab.id)}
				<li class="display:flex" {@attach tabs_reorderable.item({index})}>
					<BrowserTabListitem
						{tab}
						{index}
						onselect={(index) => browser.select_tab(index)}
						onclose={(index) => browser.close_tab(index)}
					/>
				</li>
			{/each}
			<div class="p_sm">
				<button
					type="button"
					class="plain ml_xs border_radius_md"
					style:width="32px"
					style:min-width="32px"
					style:height="32px"
					style:min-height="32px"
					onclick={() => browser.add_new_tab()}
					title="new tab"
				>
					<Svg data={icon_add} />
				</button>
			</div>
		</ul>

		<!-- navigation controls & address bar -->
		<div class="browser_controls display:flex gap_sm p_xs4">
			<div class="browser_nav_buttons display:flex gap_xs">
				<button
					type="button"
					class="icon-button plain p_xs border_radius_lg"
					title="back"
					onclick={() => browser.go_back()}
					disabled
				>
					<Svg data={icon_arrow_left} />
				</button>
				<button
					type="button"
					class="icon-button plain p_xs border_radius_lg"
					title="forward"
					onclick={() => browser.go_forward()}
					disabled
				>
					<Svg data={icon_arrow_right} />
				</button>
				<button
					type="button"
					class="icon-button plain p_xs border_radius_lg"
					title="refresh"
					onclick={() => browser.refresh()}
				>
					<Svg data={icon_refresh} />
				</button>
			</div>

			<!-- address bar -->
			<div class="browser-address-bar flex:1">
				<input
					type="text"
					bind:value={browser.edited_url}
					class="width:100% plain"
					class:url-edited={browser.url_edited}
					onkeypress={(e) => {
						if (e.key === 'Enter') {
							browser.submit_edited_url();
						}
					}}
					placeholder={GLYPH_PLACEHOLDER}
				/>
			</div>

			<!-- main menu -->
			<div class="display:flex gap_xs">
				<button
					type="button"
					class="icon-button plain p_xs"
					title="main menu"
					onclick={() => {
						// eslint-disable-next-line no-alert
						alert('not yet, thanks for clicking');
					}}
				>
					<!-- TODO fuz_ui has no dedicated menu icon yet, `icon_drag` is the same three lines -->
					<Svg data={icon_drag} label="main menu" />
				</button>
			</div>
		</div>
	</div>

	<!-- selected tab content area -->
	<div class="browser-content">
		{#if browser.tabs.selected_tab}
			<BrowserTabContent tab={browser.tabs.selected_tab}>
				{@render children()}
			</BrowserTabContent>
		{/if}
	</div>
</div>

<style>
	.browser-container {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--border_color_10);
	}

	.browser-chrome {
		border-bottom: 1px solid var(--border_color_10);
		flex-shrink: 0;
	}

	.browser-tab-bar {
		border-bottom: 1px solid var(--border_color_10);
	}

	.browser-content {
		flex: 1;
		overflow: auto;
		position: relative;
	}

	.browser-address-bar input {
		background: transparent;
	}

	.browser-address-bar input.url-edited {
		box-shadow: var(--shadow_xs)
			color-mix(
				in hsl,
				var(--shadow_color, var(--shadow_color_umbra)) var(--shadow_alpha, var(--shadow_alpha_30)),
				transparent
			);
	}
</style>

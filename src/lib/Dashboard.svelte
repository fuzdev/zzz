<script lang="ts">
	import {resolve} from '$app/paths';
	import type {Snippet} from 'svelte';
	import {page} from '$app/state';
	import {onNavigate} from '$app/navigation';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import {is_editable, swallow} from '@fuzdev/fuz_util/dom.js';
	import {slide} from 'svelte/transition';

	import {logo_zzz} from './logos.js';
	import NavLink from './NavLink.svelte';
	import Glyph from './Glyph.svelte';
	import {GLYPH_ARROW_LEFT, GLYPH_ARROW_RIGHT, GLYPH_PROJECT, GLYPH_TAB} from './glyphs.js';
	import {frontend_context} from './frontend.svelte.js';
	import {main_nav_items_default, to_nav_link_href} from './nav.js';

	// TODO dashboard should be mounted with Markdown

	const {
		children,
	}: {
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	const SIDEBAR_WIDTH_MAX = 180;
	const sidebar_width = $derived(app.ui.show_sidebar ? SIDEBAR_WIDTH_MAX : 0);

	let futureclicks = $state(0);
	const FUTURECLICKS = 3;
	// Track if futureclicks has been activated at least once
	let futureclicks_activated = $state(false);
	onNavigate((navigation) => {
		// Only reset clicks when navigating away from the root page
		// and we're not already in activated state
		if (
			!futureclicks_activated &&
			navigation.from?.route.id === '/' &&
			navigation.to?.route.id !== '/'
		) {
			console.log('resetting');
			futureclicks = 0;
		}
	});

	const dashboard_nav_items = $derived.by(() => {
		const nav_items = structuredClone(main_nav_items_default);

		if (app.futuremode) {
			// Add tabs to main group
			const main_group = nav_items.find((l) => l.group === 'main');
			if (main_group) {
				main_group.items.unshift({label: 'tabs', href: resolve('/tabs'), icon: GLYPH_TAB});
			}

			// Add projects to main group
			const main_section = nav_items.find((section) => section.group === 'main');
			if (main_section) {
				main_section.items.push({
					label: 'projects',
					href: resolve('/projects'),
					icon: GLYPH_PROJECT,
				});
			}
		}

		return nav_items;
	});

	const sidebar_button_title = $derived(
		(app.ui.show_sidebar ? 'hide sidebar' : 'show sidebar') + ' [backtick `]',
	);
</script>

<svelte:window
	onkeydowncapture={(e) => {
		if (e.key === '`' && !is_editable(e.target)) {
			app.ui.toggle_sidebar();
			swallow(e);
		}
	}}
/>

<!-- TODO drive with data -->
<div class="dashboard" style:--sidebar_width="{sidebar_width}px">
	<div
		class="height:100% width:100% position:fixed top:0 left:0"
		style:padding-left="var(--sidebar_width)"
	>
		{@render children()}
	</div>
	<div
		class="height:100% position:fixed top:0 left:0 overflow:auto scrollbar-width:thin"
		style:width="var(--sidebar_width)"
	>
		<!-- TODO refactor -->
		<div class="p_sm">
			<!-- TODO support `max_height_100` in fuz_css -->
			<nav class="font_size_lg">
				{#each dashboard_nav_items as section (section.group)}
					{#if section.group === 'main'}
						<div class="display:flex p_sm mb_sm">
							<NavLink
								href={resolve('/')}
								title={app.futuremode ? 'futuremode' : 'home'}
								class="click_effect_scale"
								onclick={() => {
									if (futureclicks_activated) {
										// If already activated once, toggle immediately when on root
										if (page.url.pathname === resolve('/')) {
											app.futuremode = !app.futuremode;
										}
									} else {
										futureclicks++;
										if (futureclicks >= FUTURECLICKS) {
											app.futuremode = !app.futuremode;
											futureclicks_activated = true;
										}
									}
								}}
							>
								<Svg
									data={logo_zzz}
									size="var(--icon_size_md)"
									fill={app.futuremode ? 'var(--color_h_5)' : undefined}
									style="transition: transform 200ms ease"
									class={app.futuremode ? 'transform:scaleX(-1)' : ''}
								/>
							</NavLink>
						</div>
					{:else}
						<div class="font_size_xl font_family_serif mt_xl7 mb_md text_color_3">
							{section.group}
						</div>
					{/if}

					{#each section.items as link (link.label)}
						<div transition:slide>
							<NavLink href={to_nav_link_href(app, link.label, link.href)}>
								{#snippet children(selected)}
									{#if typeof link.icon === 'string'}
										<Glyph glyph={link.icon} class="icon_xs" /> {link.label}
									{:else}
										<span class="icon_xs">
											<Svg
												data={link.icon}
												fill={selected ? 'var(--link_color)' : 'var(--text_color_1)'}
												size="var(--icon_size_xs)"
											/>
										</span>
										{link.label}
									{/if}
								{/snippet}
							</NavLink>
						</div>
					{/each}
				{/each}
			</nav>
		</div>
	</div>

	<!-- sidebar toggle button -->
	<button
		type="button"
		class="position:fixed bottom:0 left:0 icon_button plain border_radius_0"
		aria-label={sidebar_button_title}
		title={sidebar_button_title}
		onclick={() => app.ui.toggle_sidebar()}
	>
		<Glyph glyph={app.ui.show_sidebar ? GLYPH_ARROW_LEFT : GLYPH_ARROW_RIGHT} />
	</button>
</div>

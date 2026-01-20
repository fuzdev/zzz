<script lang="ts">
	import {slide} from 'svelte/transition';
	import type {Snippet} from 'svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import {frontend_context} from './frontend.svelte.js';
	import {GLYPH_ACTION_TYPE_REQUEST_RESPONSE} from './glyphs.js';
	import {PING_HISTORY_MAX, type PingData} from './capabilities.svelte.js';
	import Glyph from './Glyph.svelte';

	const {
		children,
	}: {
		children?: Snippet | undefined;
	} = $props();

	const app = frontend_context.get();
	const {capabilities} = app;

	// Calculate placeholders to maintain consistent spacing
	const remaining_placeholders = $derived(
		Math.max(0, PING_HISTORY_MAX - capabilities.pings.length),
	);

	// TODO consider multiple buttons for each transport, so we can compare latency
</script>

<form class="column align-items:start gap_sm">
	<div>
		<button type="button" title="ping the server" onclick={() => app.api.ping()} class="flex:1">
			{#if children}{@render children()}{:else}⚞{/if}
			<div class="font_size_lg font-weight:400 pl_sm">ping the server</div>
		</button>
	</div>

	<ul
		class="unstyled column panel p_md pb_0 mb_0 shadow_inset_top_xs"
		style:height="150px"
		style:min-height="150px"
	>
		<!-- Display all pings, both pending and completed -->
		{#each capabilities.pings as ping (ping.ping_id)}
			<li transition:slide>
				{@render ping_item(ping)}
			</li>
		{/each}

		<!-- Empty placeholders to maintain consistent size -->
		{#each {length: remaining_placeholders} as _, i (i)}
			<li transition:slide>
				<div style:visibility="hidden">
					{@render ping_item({
						ping_id: (i + ' placeholder') as any,
						completed: true,
						sent_time: 0,
						received_time: 0,
						round_trip_time: 0,
					})}
				</div>
			</li>
		{/each}
	</ul>
</form>

{#snippet ping_item(ping: PingData)}
	<Glyph glyph={GLYPH_ACTION_TYPE_REQUEST_RESPONSE} class={ping.completed ? '' : 'opacity_40'} />
	{#if !ping.completed}
		<span class="font_family_mono">
			<PendingAnimation inline />
		</span>
	{:else if ping.round_trip_time === null}
		<span class="font_family_mono color_c_5"
			>✗ {ping.received_time ? Math.round(ping.received_time - ping.sent_time) : 0}ms</span
		>
	{:else}
		<span class="font_family_mono">{Math.round(ping.round_trip_time)}ms</span>
	{/if}
{/snippet}

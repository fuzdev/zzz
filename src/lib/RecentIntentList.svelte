<script lang="ts">
	import { icon_error } from '@fuzdev/fuz_ui/icons.ts';

	import { app_context } from './app.svelte.ts';
	import Icon from './Icon.svelte';
	import { get_icon_for_action_kind } from './action_icons.ts';
	import type { RecentIntent } from './recent_intents.svelte.ts';
	import { format_time } from './time_helpers.ts';

	const {
		limit = 50,
		selected_seq = null,
		onselect
	}: {
		/** How many of the newest entries to show. */
		limit?: number | undefined;
		selected_seq?: number | null | undefined;
		onselect?: ((entry: RecentIntent) => void) | undefined;
	} = $props();

	const app = app_context.get();

	const recent_intents = $derived(app.recent_intents);

	/** Newest first. */
	const shown = $derived(recent_intents.entries.slice(-limit).reverse());
</script>

<section>
	<header class="row gap_sm justify-content:space-between p_sm">
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
				<li>
					<button
						type="button"
						class="width:100% text-align:left justify-content:start py_xs px_md border-radius:0 border-style:none box-shadow:none"
						class:selected={entry.seq === selected_seq}
						class:palette_c={entry.outcome === 'failed'}
						title={entry.error ?? undefined}
						onclick={() => onselect?.(entry)}
					>
						<div class="font-weight:400 flex align-items:center gap_xs width:100%">
							<Icon data={get_icon_for_action_kind('local_call')} />
							<span class="font_family_mono flex:1 ellipsis">{entry.method}</span>
							{#if entry.outcome === 'failed'}
								<Icon class="color_c_60" data={icon_error} />
							{/if}
							<small class="font_family_mono ml_auto">{format_time(entry.at)}</small>
						</div>
					</button>
				</li>
			{/each}
		</ol>
	{:else}
		<p class="px_sm"><small>no intents yet — the menus, tabs, and shortcuts call them</small></p>
	{/if}
</section>

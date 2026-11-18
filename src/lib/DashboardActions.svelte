<script lang="ts">
	import ActionList from './ActionList.svelte';
	import ActionDetail from './ActionDetail.svelte';
	import DashboardHeader from './DashboardHeader.svelte';
	import { icon_log } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import type { Action } from './action.svelte.ts';
	import { app_context } from './app.svelte.ts';
	import TimeWidget from './TimeWidget.svelte';
	import RecentIntentList from './RecentIntentList.svelte';
	import RecentIntentDetail from './RecentIntentDetail.svelte';
	import type { RecentIntent } from './recent_intents.svelte.ts';
	import { random_item } from '@fuzdev/fuz_util/random.ts';
	import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

	const app = app_context.get();

	const { actions } = $derived(app);

	// looked up by id, so an action deleted from history or trimmed past the
	// history limit deselects instead of lingering disposed
	let selected_action_id: Uuid | null = $state.raw(null);
	const selected_action: Action | null = $derived(
		selected_action_id === null ? null : (actions.items.by_id.get(selected_action_id) ?? null)
	);

	// one selection across both lists — by seq, so a cleared or evicted intent deselects too
	let selected_intent_seq: number | null = $state.raw(null);
	const selected_intent: RecentIntent | null = $derived(
		selected_intent_seq === null
			? null
			: (app.recent_intents.entries.find((entry) => entry.seq === selected_intent_seq) ?? null)
	);
</script>

<div class="column p_lg height:100%">
	<DashboardHeader>
		{#snippet header()}
			<h1><Icon data={icon_log} /> system actions</h1>
		{/snippet}
		<TimeWidget value={app.time.now} />
	</DashboardHeader>
	<p class="width_atmost_md mb_lg">
		This page shows the actions that have happened behind the scenes. It's a work in progress and
		not too useful yet. The idea is to make the system visible, auditable, and manipulable.
	</p>
	<p class="row gap_sm mb_lg">
		<button
			type="button"
			class="sized_sm"
			onclick={() => {
				actions.items.clear();
			}}
			disabled={!actions.items.size}
		>
			clear action history
		</button>
		<button type="button" class="sized_sm" onclick={() => app.api.ping()}>ping</button>
	</p>

	<div
		class="flex:1 grid overflow:hidden"
		style:grid-template-columns="320px 1fr"
		style:gap="var(--space_md)"
	>
		<div
			class="overflow:auto scrollbar-width:thin"
			style:border-right="1px solid var(--border_color)"
		>
			<h2 class="p_sm mt_0 mb_0">wire log</h2>
			<ActionList
				limit={100}
				{selected_action_id}
				onselect={(action) => {
					selected_action_id = action.id;
					selected_intent_seq = null;
				}}
			/>
			<div style:border-top="1px solid var(--border_color)">
				<RecentIntentList
					limit={30}
					selected_seq={selected_intent?.seq ?? null}
					onselect={(entry) => {
						selected_intent_seq = entry.seq;
						selected_action_id = null;
					}}
				/>
			</div>
		</div>

		<div class="panel p_md overflow:auto height:100%">
			{#if selected_intent}
				<RecentIntentDetail entry={selected_intent} />
			{:else if selected_action}
				<ActionDetail action={selected_action} />
			{:else if actions.items.size > 0}
				<div class="box height:100%">
					<p>
						select an action from the list or
						<button
							type="button"
							class="inline palette_f"
							onclick={() => {
								selected_action_id = random_item(actions.items.values).id;
								selected_intent_seq = null;
							}}
						>
							go fish
						</button> to view its details
					</p>
				</div>
			{:else}
				<div class="box height:100%">
					<p>
						no wire actions yet —
						<button
							type="button"
							class="inline palette_d"
							onclick={() => {
								void app.api.ping();
							}}
						>
							ping the daemon
						</button>
					</p>
				</div>
			{/if}
		</div>
	</div>
</div>

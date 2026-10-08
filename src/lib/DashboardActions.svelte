<script lang="ts">
	import ActionList from './ActionList.svelte';
	import ActionDetail from './ActionDetail.svelte';
	import DashboardHeader from './DashboardHeader.svelte';
	import { icon_log } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import type { Action } from './action.svelte.ts';
	import { app_context } from './app.svelte.ts';
	import TimeWidget from './TimeWidget.svelte';
	import { random_item } from '@fuzdev/fuz_util/random.ts';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';

	const app = app_context.get();

	const { actions } = $derived(app);

	// looked up by id, so an action deleted from history or trimmed past the
	// history limit deselects instead of lingering disposed
	let selected_action_id: Uuid | null = $state.raw(null);
	const selected_action: Action | null = $derived(
		selected_action_id === null ? null : (actions.items.by_id.get(selected_action_id) ?? null)
	);
</script>

<div class="column p_lg height:100%">
	<DashboardHeader>
		{#snippet header()}
			<h1><Icon data={icon_log} /> system actions</h1>
		{/snippet}
		<TimeWidget value={app.time.now} />
	</DashboardHeader>
	<p class="width_atmost_md">
		This page shows the actions that have happened behind the scenes. It's a work in progress and
		not too useful yet. The idea is to make the system visible, auditable, and manipulable.
	</p>
	<p class="row gap_sm">
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
		class="flex:1 display:grid overflow:hidden"
		style:grid-template-columns="320px 1fr"
		style:gap="var(--space_md)"
	>
		<div
			class="overflow:auto scrollbar-width:thin"
			style:border-right="1px solid var(--border_color)"
		>
			<ActionList
				limit={100}
				{selected_action_id}
				onselect={(action) => {
					selected_action_id = action.id;
				}}
			/>
		</div>

		<div class="panel p_md overflow:auto height:100%">
			{#if selected_action}
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
							}}
						>
							go fish
						</button> to view its details
					</p>
				</div>
			{:else}
				<div class="box height:100%">
					<p>
						no actions yet,
						<button
							type="button"
							class="inline palette_d"
							onclick={() => {
								app.api.toggle_main_menu();
							}}
						>
							do something?
						</button>?
					</p>
				</div>
			{/if}
		</div>
	</div>
</div>

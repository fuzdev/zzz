<script lang="ts">
	import ActionList from './ActionList.svelte';
	import ActionDetail from './ActionDetail.svelte';
	import DashboardHeader from './DashboardHeader.svelte';
	import { icon_log } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import type { Action } from './action.svelte.ts';
	import { app_context } from './app.svelte.ts';
	import TimeWidget from './TimeWidget.svelte';
	import { random_item } from '@fuzdev/fuz_util/random.ts';

	const app = app_context.get();

	const { actions } = $derived(app);

	// TODO could potentially be removed from the collection by some external process,
	// so having this state be component-local solves some problems but not all
	let selected_action: Action | null = $state.raw(null);
</script>

<div class="column p_lg height:100%">
	<DashboardHeader>
		{#snippet header()}
			<h1><Svg data={icon_log} /> system actions</h1>
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
			class="sm"
			onclick={() => {
				actions.items.clear();
				selected_action = null;
			}}
			disabled={!actions.items.size}
		>
			clear action history
		</button>
		<button type="button" class="sm" onclick={() => app.api.ping()}>ping</button>
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
				selected_action_id={selected_action?.id}
				onselect={(action) => {
					selected_action = action;
				}}
			/>
		</div>

		<div class="panel p_md overflow:auto height:100%">
			{#if selected_action}
				<ActionDetail action={selected_action} />
			{:else if actions.items.size > 0}
				<div class="box height:100%">
					<p>
						select an action from the list or <button
							type="button"
							class="inline palette_f"
							onclick={() => {
								selected_action = random_item(actions.items.values);
							}}
						>
							go fish
						</button> to view its details
					</p>
				</div>
			{:else}
				<div class="box height:100%">
					<p>
						no actions yet, <button
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

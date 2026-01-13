<script lang="ts">
	import type {Chat} from './chat.svelte.js';
	import type {Thread} from './thread.svelte.js';
	import ChatThread from './ChatThread.svelte';
	import ChatThreadAddByModel from './ChatThreadAddByModel.svelte';
	import ChatThreadManageByTag from './ChatThreadManageByTag.svelte';

	const {
		chat,
		thread,
	}: {
		chat: Chat;
		thread: Thread | undefined;
	} = $props();

	const turn_count = $derived(thread?.turns.size);

	const empty = $derived(!turn_count);
</script>

<!-- TODO the overflow change is hacky, allows the shadow to overlap the sidebar -->
{#if thread}
	<div
		class="column_fluid column flex:1"
		class:pr_xl={empty}
		style:overflow={empty ? 'visible' : undefined}
		style:justify-content={empty ? 'center' : undefined}
	>
		<!-- the two `p_sm` are expected to stay in sync so the size is the same regardless of presentation style -->
		<div
			class="column width_upto_md width_atleast_sm"
			class:height_100={!empty}
			class:p_sm={!empty}
		>
			<ChatThread
				{thread}
				onsend={(input) => chat.send_to_thread(thread.id, input)}
				attrs={{class: empty ? 'floating p_sm' : 'height:100%'}}
				focus_key={chat.id}
				bind:pending_element_to_focus_key={
					() => chat.app.ui.pending_element_to_focus_key,
					(v) => {
						chat.app.ui.pending_element_to_focus_key = v;
					}
				}
			/>
		</div>
	</div>
{:else}
	<section class="column_section">
		<ChatThreadAddByModel {chat} />
	</section>
	<section class="column_section">
		<ChatThreadManageByTag {chat} />
	</section>
{/if}

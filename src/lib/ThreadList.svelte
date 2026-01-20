<script lang="ts">
	import {slide} from 'svelte/transition';

	import type {Chat} from './chat.svelte.js';
	import {Reorderable} from './reorderable.svelte.js';
	import ThreadListitem from './ThreadListitem.svelte';
	import {frontend_context} from './frontend.svelte.js';

	const {
		chat = frontend_context.get().chats.selected,
	}: {
		chat?: Chat | undefined;
	} = $props();

	const reorderable = new Reorderable();

	// TODO for "single" chat views we need this to show the first thread as selected
</script>

{#if chat}
	<ul
		class="unstyled column gap_xs5"
		{@attach reorderable.list({
			onreorder: (from_index, to_index) => {
				chat.reorder_threads(from_index, to_index);
			},
		})}
	>
		{#each chat.threads as thread, i (thread.id)}
			<li class="border_radius_xs" {@attach reorderable.item({index: i})} transition:slide>
				<ThreadListitem {thread} {chat} />
			</li>
		{/each}
	</ul>
{:else}
	<p class="text-align:center">No chat selected</p>
{/if}

<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	import type {Thread} from './thread.svelte.js';

	const {
		thread,
		attrs,
	}: {
		thread: Thread;
		attrs?: SvelteHTMLElements['input'] | undefined;
	} = $props();
</script>

<input
	type="checkbox"
	class="plain sm"
	style:height="auto"
	title="this thread is {thread.enabled ? 'enabled' : 'disabled'} and {thread.enabled
		? ''
		: 'not '}included in the chat"
	bind:checked={thread.enabled}
	{...attrs}
/>

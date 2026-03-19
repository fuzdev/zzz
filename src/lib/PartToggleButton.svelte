<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	import type {PartUnion} from './part.svelte.js';

	const {
		part,
		attrs,
	}: {
		part: PartUnion;
		attrs?: SvelteHTMLElements['input'] | undefined;
	} = $props();
</script>

<input
	type="checkbox"
	class="plain sm"
	title="this part is {part.enabled ? 'enabled' : 'disabled'} and {part.enabled
		? ''
		: 'not '}included in the prompt"
	bind:checked={part.enabled}
	{...attrs}
/>

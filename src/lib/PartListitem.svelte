<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	import type {PartUnion} from './part.svelte.js';
	import PartContextmenu from './PartContextmenu.svelte';

	const {
		part,
		selected,
		onclick,
		compact = true,
		attrs,
	}: {
		part: PartUnion;
		selected?: boolean | undefined;
		onclick?: ((part: PartUnion) => void) | undefined;
		compact?: boolean | undefined;
		attrs?: SvelteHTMLElements['button'] | undefined;
	} = $props();
</script>

<PartContextmenu {part}>
	<button
		type="button"
		class="listitem width:100%"
		{...attrs}
		class:selected
		class:compact
		onclick={onclick ? () => onclick(part) : undefined}
	>
		<div class="p_xs font_size_sm">
			<span class="mr_xs">{part.type}</span>
			<span class="ellipsis">{part.content_preview}</span>
			{#if part.token_count != null}
				<span class="font_size_xs ml_xs">{part.token_count}</span>
			{/if}
		</div>
	</button>
</PartContextmenu>

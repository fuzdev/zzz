<script lang="ts">
	import {resolve} from '$app/paths';

	import NavLink from './NavLink.svelte';
	import {GLYPH_PROMPT} from './glyphs.js';
	import PromptContextmenu from './PromptContextmenu.svelte';
	import type {Prompt} from './prompt.svelte.js';
	import Glyph from './Glyph.svelte';

	const {
		prompt,
		selected,
	}: {
		prompt: Prompt;
		selected?: boolean | undefined;
	} = $props();
</script>

<PromptContextmenu {prompt}>
	<NavLink
		href={resolve(`/prompts/${prompt.id}`)}
		{selected}
		class="justify-content:space-between"
		style="min-height: 0;"
	>
		<div class="ellipsis">
			<Glyph glyph={GLYPH_PROMPT} class="mr_xs2" />
			<span>{prompt.name}</span>
		</div>
		{#if prompt.parts.length}<small>{prompt.parts.length}</small>{/if}
	</NavLink>
</PromptContextmenu>

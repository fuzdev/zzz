<script lang="ts">
	import { resolve } from '$app/paths';

	import NavLink from './NavLink.svelte';
	import { icon_prompt } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import PromptContextmenu from './PromptContextmenu.svelte';
	import type { Prompt } from './prompt.svelte.ts';

	const {
		prompt,
		selected
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
			<Svg data={icon_prompt} class="mr_xs2" />
			<span>{prompt.name}</span>
		</div>
		{#if prompt.parts.length}<small>{prompt.parts.length}</small>{/if}
	</NavLink>
</PromptContextmenu>

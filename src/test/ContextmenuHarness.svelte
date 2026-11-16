<script lang="ts">
	// Test harness: a contextmenu component (`PartContextmenu`, `TurnContextmenu`, …)
	// under a `ContextmenuRoot`, around a target to right-click.
	import type { Component } from 'svelte';
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	const { menu: Menu, props }: { menu: Component<any>; props: Record<string, unknown> } = $props();
</script>

<ContextmenuRoot>
	<Menu {...props}>
		<span class="contextmenu-target">target</span>
	</Menu>
</ContextmenuRoot>

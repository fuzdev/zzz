<script lang="ts">
	// Test harness: `DiskfileContextmenu` under a `ContextmenuRoot`, around a target to right-click.
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import DiskfileContextmenu from '$lib/DiskfileContextmenu.svelte';
	import type { Diskfile } from '$lib/diskfile.svelte.ts';

	const { diskfile }: { diskfile: Diskfile } = $props();
</script>

<ContextmenuRoot>
	<DiskfileContextmenu {diskfile}>
		<span class="contextmenu-target">{diskfile.path}</span>
	</DiskfileContextmenu>
</ContextmenuRoot>

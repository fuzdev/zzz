<script lang="ts">
	// Test harness: `DiskfileExplorer` under a `ContextmenuRoot`, so its rows' menus open.
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import DiskfileExplorer from '#lib/DiskfileExplorer.svelte';
</script>

<ContextmenuRoot>
	<DiskfileExplorer />
</ContextmenuRoot>

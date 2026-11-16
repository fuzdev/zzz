<script lang="ts">
	// Test harness: `DiskfileTabListitem` under a `ContextmenuRoot`, so its menu opens.
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import DiskfileTabListitem from '#lib/DiskfileTabListitem.svelte';
	import type { DiskfileTab } from '#lib/diskfile_tab.svelte.ts';

	const { tab }: { tab: DiskfileTab } = $props();
</script>

<ContextmenuRoot>
	<DiskfileTabListitem {tab} onselect={() => {}} onclose={() => {}} onopen={() => {}} />
</ContextmenuRoot>

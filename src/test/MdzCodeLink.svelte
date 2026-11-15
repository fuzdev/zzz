<script lang="ts">
	// Test component: an mdz `code` component rendering its span as a link to a file the test
	// indexes, carrying the offset props mdz passes it onto the anchor.
	import type { MdzSourceOffsetProps } from '@fuzdev/mdz/mdz_contexts.ts';

	const { reference, ...rest }: { reference: string } & MdzSourceOffsetProps = $props();
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a href="./{reference}.md" {...rest}>{reference}</a>

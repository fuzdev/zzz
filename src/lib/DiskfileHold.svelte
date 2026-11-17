<script lang="ts">
	import type { Snippet } from 'svelte';

	import type { DiskfilePath } from './diskfile_types.ts';
	import { frontend_context } from './frontend.svelte.ts';

	/*

	Holds the cell of the file at `path` while mounted (`Diskfiles.hold`), so what it
	renders can read it with `peek` — made from the index's record if nothing held it —
	from its effect on: its first render sees no cell, and `peek` readers re-run as the
	cell arrives.

	*/

	const {
		path,
		children
	}: {
		path: DiskfilePath;
		children: Snippet;
	} = $props();

	const { diskfiles } = frontend_context.get();

	$effect(() => diskfiles.hold(path));
</script>

{@render children()}

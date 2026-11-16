<script lang="ts">
	import { frontend_context } from './frontend.svelte.ts';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import { to_diskfile_copy_paths } from './diskfile_helpers.ts';

	/**
	 * The copy entries of a file's or folder's contextmenu: its absolute path,
	 * its path relative to the innermost root holding it, and its name (see
	 * `to_diskfile_copy_paths`). A root copies only its path — relative to
	 * itself it's empty, and its name says less than its path.
	 *
	 * @module
	 */

	const {
		path,
		root = false
	}: {
		/** A file's path, or a folder's with a trailing `/`. */
		path: string;
		/** Whether `path` is an indexed root, shown as its own row. */
		root?: boolean | undefined;
	} = $props();

	const { diskfiles } = frontend_context.get();

	const copies = $derived(to_diskfile_copy_paths(path, diskfiles.indexed_roots));
</script>

<ContextmenuEntryCopyToClipboard content={copies.absolute} label="copy path" />
{#if !root}
	{#if copies.relative}
		<ContextmenuEntryCopyToClipboard content={copies.relative} label="copy relative path" />
	{/if}
	<ContextmenuEntryCopyToClipboard content={copies.name} label="copy name" />
{/if}

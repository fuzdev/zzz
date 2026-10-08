<script lang="ts">
	import { swallow } from '@fuzdev/fuz_util/dom.ts';

	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import { icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { frontend_context } from './frontend.svelte.ts';

	const {
		diskfile,
		selected = false,
		attrs,
		onselect
	}: {
		diskfile: Diskfile;
		selected?: boolean | undefined;
		attrs?: Record<string, unknown>;
		/**
		 * `open_not_preview` indicates a "open_not_preview select"
		 * like a doubleclick or enter keypress.
		 */
		onselect?: (diskfile: Diskfile, open_not_preview: boolean) => void;
	} = $props();

	const app = frontend_context.get();

	// only files already opened have an editing state — listing never creates one
	const editor_state = $derived(app.diskfiles.find_editor_state(diskfile.id));
	const dirty = $derived(editor_state?.dirty ?? false);
	const conflict = $derived(editor_state?.has_conflict ?? false);

	// TODO add a visible status when open in a tab
</script>

<DiskfileContextmenu {diskfile}>
	<div
		role="button"
		tabindex="0"
		class="menuitem sized_sm ellipsis"
		class:selected
		{...attrs}
		onclick={onselect
			? (e) => {
					swallow(e);
					onselect(diskfile, e.detail === 2);
				}
			: undefined}
		onkeydown={onselect
			? (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						swallow(e);
						onselect(diskfile, true);
					}
				}
			: undefined}
		aria-label={[
			diskfile.path_relative,
			diskfile.deleted_on_disk && 'deleted on disk',
			conflict ? 'unsaved changes, changed on disk' : dirty && 'unsaved changes'
		]
			.filter(Boolean)
			.join(', ') || undefined}
		aria-pressed={selected}
	>
		<small class="ellipsis">
			<Icon data={icon_file} />
			<span class="ml_xs" class:deleted={diskfile.deleted_on_disk}>{diskfile.path_relative}</span>
			{#if diskfile.deleted_on_disk}
				<span class="color_c_60" aria-hidden="true">(deleted)</span>
			{/if}
			{#if dirty}
				<span class:color_c_50={conflict} aria-hidden="true">●</span>
			{/if}
		</small>
	</div>
</DiskfileContextmenu>

<style>
	.deleted {
		text-decoration: line-through;
	}
</style>

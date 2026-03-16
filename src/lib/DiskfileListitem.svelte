<script lang="ts">
	import {swallow} from '@fuzdev/fuz_util/dom.js';

	import type {Diskfile} from './diskfile.svelte.js';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import Glyph from './Glyph.svelte';
	import {GLYPH_FILE} from './glyphs.js';

	const {
		diskfile,
		selected = false,
		attrs,
		onselect,
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

	// TODO add a visible status when open in a tab
</script>

<DiskfileContextmenu {diskfile}>
	<div
		role="button"
		tabindex="0"
		class="menuitem compact ellipsis cursor_pointer"
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
		aria-label={diskfile.path_relative ?? undefined}
		aria-pressed={selected}
	>
		<small class="ellipsis">
			<Glyph glyph={GLYPH_FILE} />
			<span class="ml_xs">{diskfile.path_relative}</span>
		</small>
	</div>
</DiskfileContextmenu>

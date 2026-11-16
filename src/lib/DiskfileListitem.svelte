<script lang="ts">
	import { swallow } from '@fuzdev/fuz_util/dom.ts';

	import type { Diskfile } from './diskfile.svelte.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import { icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileStatusLabel from './DiskfileStatusLabel.svelte';
	import { to_diskfile_status, to_diskfile_status_label } from './diskfile_helpers.ts';

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

	const status = $derived(to_diskfile_status(app.diskfiles, diskfile));

	// TODO add a visible status when open in a tab
</script>

<DiskfileContextmenu {diskfile}>
	<div
		role="button"
		tabindex="0"
		class="menuitem sized_sm"
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
		aria-label={to_diskfile_status_label(diskfile.path_relative, status)}
		aria-pressed={selected}
	>
		<!-- only the path truncates, so the markers after it always show -->
		<small class="row min-width:0">
			<Icon data={icon_file} />
			<DiskfileStatusLabel label={diskfile.path_relative} {status} />
		</small>
	</div>
</DiskfileContextmenu>

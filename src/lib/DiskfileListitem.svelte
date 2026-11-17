<script lang="ts">
	import { swallow } from '@fuzdev/fuz_util/dom.ts';

	import type { DiskfilePath } from './diskfile_types.ts';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import { icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import DiskfileStatusLabel from './DiskfileStatusLabel.svelte';
	import { to_diskfile_status, to_diskfile_status_label } from './diskfile_helpers.ts';

	const {
		path,
		selected = false,
		reveal_in_tree = false,
		attrs,
		onselect
	}: {
		path: DiskfilePath;
		selected?: boolean | undefined;
		/** Whether its contextmenu offers "reveal in tree" — see `DiskfileContextmenu`. */
		reveal_in_tree?: boolean | undefined;
		attrs?: Record<string, unknown>;
		/**
		 * Called on a click or Space with `open_not_preview` false (a preview),
		 * and on a double click or Enter with it true (a permanent tab), as the
		 * tree's rows do.
		 */
		onselect?: (path: DiskfilePath, open_not_preview: boolean) => void;
	} = $props();

	const app = frontend_context.get();

	const label = $derived(app.diskfiles.to_relative_path(path));
	const status = $derived(to_diskfile_status(app.diskfiles, path));

	// TODO add a visible status when open in a tab
</script>

<DiskfileContextmenu {path} {reveal_in_tree}>
	<div
		role="button"
		tabindex="0"
		class="menuitem sized_sm"
		class:selected
		{...attrs}
		onclick={onselect
			? (e) => {
					swallow(e);
					onselect(path, e.detail === 2);
				}
			: undefined}
		onkeydown={onselect
			? (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						swallow(e);
						onselect(path, e.key === 'Enter');
					}
				}
			: undefined}
		aria-label={to_diskfile_status_label(label, status)}
		aria-pressed={selected}
	>
		<!-- only the path truncates, so the markers after it always show -->
		<small class="row min-width:0">
			<Icon data={icon_file} />
			<DiskfileStatusLabel {label} {status} />
		</small>
	</div>
</DiskfileContextmenu>

<script lang="ts" module>
	/** The drawer's id, which the files header's toggle names in `aria-controls` - one file view shows at a time. */
	export const DISKFILE_DETAILS_DRAWER_ID = 'diskfile-details';
</script>

<script lang="ts">
	import { untrack, type Snippet } from 'svelte';

	import { frontend_context } from './frontend.svelte.ts';

	/*

	A file view's details - its actions, info, and history - in a drawer at the view's right edge,
	open while `Ui.show_diskfile_details` is, a layout preference shared by every file. The files
	header's toggle writes it, and the drawer follows.

	The wrapper takes the drawer's width in the flow, or none, at once, so the panes beside it resize
	once per toggle rather than reflowing every frame. The content sits out of the flow at the view's
	right edge, the drawer's width whether open or not, so nothing in it re-wraps, and clips the
	panel, which slides in from beyond that edge and back out over it - closing, across the panes
	that have already widened. Its `z-index` is over the panes, so the view's root is a stacking
	context (`isolation:isolate`), which keeps it under the desk menu's overlay.

	*/

	const {
		children
	}: {
		/** The details, rendered in the drawer's panel while it's open or sliding. */
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	// the drawer as drawn, which follows the setting - an open a step behind, while the content
	// mounts off the drawer's edge. The first render doesn't animate, since the content starts in
	// place, and neither does a remount, as on a file switch (each file mounts a fresh view, see
	// `DiskfileView`)
	let open = $state.raw(app.ui.show_diskfile_details);
	// the drawer's content renders until its close animation ends - closing, it's inert as it slides
	// out; closed, it's gone
	let content_shown = $state.raw(app.ui.show_diskfile_details);
	// the part of the content that slides, whose `transform` transition is the drawer's animation -
	// set and cleared with its mount, so it's never a detached element
	let panel_el: HTMLElement | undefined = $state.raw();

	// whether an open is waiting on the content it mounted - not state, the effect sets and reads it
	let mounting = false;

	// an open is two steps, since it starts from a setting change and an effect can't `flushSync`:
	// the content mounts closed, off the drawer's edge, and once its panel is in the document (which
	// reruns this) a layout read styles it there before the drawer opens, so its move into place
	// transitions. A reopen mid-close mounts nothing and moves the panel back from where it is
	$effect(() => {
		const next = app.ui.show_diskfile_details;
		const panel = panel_el;
		untrack(() => {
			if (!next) {
				mounting = false;
				if (!open) return;
				open = false;
				// with no motion (`prefers-reduced-motion` unsets fuz_css's durations, so the transition
				// computes to 0s) no transition ends it
				if (!has_motion()) content_shown = false;
			} else if (!open) {
				if (!panel) {
					mounting = true;
					content_shown = true;
					return;
				}
				if (mounting) {
					mounting = false;
					panel.getBoundingClientRect();
				}
				open = true;
			}
		});
	});

	/** Whether the panel animates its slide, so a `transitionend` will follow. */
	const has_motion = (): boolean =>
		!!panel_el && parseFloat(getComputedStyle(panel_el).transitionDuration) > 0;

	const handle_transition_end = (event: TransitionEvent): void => {
		// the panel's own slide, not a transition inside it - and only once it's closed, so the end
		// of a reopen mid-close changes nothing. A cancelled transition isn't listened for: closing
		// during the open's slide cancels it, and the content stays for the close's own. A close
		// cancelled with none after it (an ancestor hidden mid-close) leaves the content mounted,
		// inert and clipped off the drawer's edge, until the next close
		if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
		if (!open) content_shown = false;
	};
</script>

<div id={DISKFILE_DETAILS_DRAWER_ID} class="details-drawer" class:open>
	{#if content_shown}
		<div class="details-drawer-content" inert={!open}>
			<div
				class="details-drawer-panel shade_00 py_md"
				ontransitionend={handle_transition_end}
				{@attach (el) => {
					panel_el = el;
					return () => {
						panel_el = undefined;
					};
				}}
			>
				{@render children()}
			</div>
		</div>
	{/if}
</div>

<style>
	.details-drawer {
		position: relative;
		flex-shrink: 0;
		width: 0;
	}
	.details-drawer.open {
		width: var(--distance_sm);
	}
	.details-drawer-content {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 1;
		width: var(--distance_sm);
		overflow: clip;
	}
	.details-drawer-panel {
		height: 100%;
		overflow: auto;
		transform: translate3d(100%, 0, 0);
		transition: transform var(--duration_2) ease-in-out;
	}
	.details-drawer.open .details-drawer-panel {
		transform: translate3d(0, 0, 0);
	}
</style>

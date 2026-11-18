<script module lang="ts">
	export const DESK_WIDTH = 260;

	/** `Ui.pending_element_to_focus_key` value that hands focus back to the desk menu button. */
	export const DESK_MENU_BUTTON_FOCUS_KEY = 'desk_menu_button';
</script>

<script lang="ts">
	import type { Attachment } from 'svelte/attachments';

	import { resolve } from '$app/paths';
	import { icon_pin, icon_project } from '@fuzdev/fuz_ui/icons.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import Icon from './Icon.svelte';
	import { click_outside } from './click_outside.svelte.ts';
	import { PROJECT_DEGRADED_NOTICE } from './project_helpers.ts';

	const app = frontend_context.get();

	// the desk menu button is removed while the menu shows, so opening it from
	// the button would drop focus to `body` — take it instead, and on close
	// hand it back to the button if it was inside the menu
	const manage_focus: Attachment<HTMLElement> = (el) => {
		const focus_dropped = (): boolean =>
			!document.activeElement || document.activeElement === document.body;
		if (focus_dropped()) el.focus();
		// tracked, not checked at teardown, when the menu may already be detached
		let focused_inside = el.contains(document.activeElement);
		const onfocusin = () => {
			focused_inside = true;
		};
		const onfocusout = (e: FocusEvent) => {
			// no `relatedTarget` means focus dropped to `body`, e.g. as the menu is removed
			if (e.relatedTarget instanceof Node) focused_inside = el.contains(e.relatedTarget);
		};
		el.addEventListener('focusin', onfocusin);
		el.addEventListener('focusout', onfocusout);
		return () => {
			el.removeEventListener('focusin', onfocusin);
			el.removeEventListener('focusout', onfocusout);
			if (focused_inside && (focus_dropped() || el.contains(document.activeElement))) {
				app.ui.pending_element_to_focus_key = DESK_MENU_BUTTON_FOCUS_KEY;
			}
		};
	};
</script>

{#if app.ui.show_desk_menu}
	<aside
		class="desk-sidebar unstyled p_md"
		tabindex="-1"
		aria-label="desk menu"
		{@attach manage_focus}
		{@attach app.ui.desk_pinned
			? null
			: click_outside(() => app.intents.desk_toggle({ show: false }))}
	>
		<section>
			<div class="row gap_sm mb_xl">
				<h2 class="mt_0 flex:1">
					<Icon data={icon_project} /> projects
				</h2>
				<button
					type="button"
					class="icon-button sized_sm"
					class:selected={app.ui.desk_pinned}
					title={app.ui.desk_pinned ? 'unpin desk' : 'pin desk'}
					onclick={() => app.intents.desk_pin_toggle()}
				>
					<Icon data={icon_pin} />
				</button>
			</div>
			{#if app.projects.items.by_id.size > 0}
				<ul class="unstyled">
					{#each app.projects.items.values as project (project.id)}
						<li>
							<button
								type="button"
								class="width:100% gap_sm"
								class:selected={project.id === app.projects.active_id}
								aria-pressed={project.id === app.projects.active_id}
								title={project.id === app.projects.active_id
									? `${project.root} is the active project`
									: `make ${project.root} the active project`}
								onclick={() => app.projects.activate(project.id)}
							>
								<span class="flex:1 text-align:left">
									<span class="block">{project.name}</span>
									<span class="block font_size_sm font_family_mono text_50">
										{project.root}
									</span>
								</span>
								{#if project.watch_status === 'degraded'}
									<small class="text_50" title={PROJECT_DEGRADED_NOTICE}>polled</small>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text_50">no projects open</p>
			{/if}
			<p><a href={resolve('/projects')}>open and close projects</a></p>
		</section>
	</aside>
{/if}

<style>
	.desk-sidebar {
		position: fixed;
		top: 0;
		right: 0;
		height: 100%;
		width: 260px;
		overflow: auto;
		scrollbar-width: thin;
		background: var(--shade_10);
		border-left: var(--border_width) solid var(--border_color);
		z-index: 1;
	}
</style>

<script lang="ts">
	import {GLYPH_ARROW_LEFT, GLYPH_ARROW_RIGHT, GLYPH_REFRESH} from './glyphs.js';
	import Glyph from './Glyph.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import type {DiskfileEditorState} from './diskfile_editor_state.svelte.js';
	import type {Uuid} from './zod_helpers.js';

	const {
		editor_state,
	}: {
		editor_state: DiskfileEditorState;
	} = $props();

	const app = frontend_context.get();
	const {diskfiles} = app;
	const {editor} = diskfiles;

	// Track navigation history
	let history_stack = $state<Array<Uuid>>([]); // Forward stack (for "back" operations)
	let future_stack = $state<Array<Uuid>>([]); // Future stack (for "forward" operations)
	let current_id = $state<Uuid | null>(null); // Currently displayed tab id

	// Initialize current_id with the selected tab
	$effect.pre(() => {
		if (editor.tabs.selected_tab_id && current_id === null) {
			current_id = editor.tabs.selected_tab_id;
		}
	});

	// Update history when tab selection changes (not through our navigation)
	$effect.pre(() => {
		const selected_id = editor.tabs.selected_tab_id;

		// If selection changed to a new tab that's not in our navigation path
		if (selected_id && selected_id !== current_id) {
			// If we have a current id, push it to history stack
			if (current_id) {
				history_stack = [current_id, ...history_stack];
			}

			// Clear forward navigation
			future_stack = [];

			// Update current id
			current_id = selected_id;
		}
	});

	// Determine if navigation buttons should be enabled
	const can_go_back = $derived(history_stack.length > 0);
	const can_go_forward = $derived(future_stack.length > 0);

	// Navigation functions using tab history
	const go_back = () => {
		if (!can_go_back) return;

		// Get the previous tab from history
		const previous_id = history_stack[0];
		if (!previous_id) return; // Defensive check

		const remaining_history = history_stack.slice(1);

		// Push current tab to future stack
		if (current_id) {
			future_stack = [current_id, ...future_stack];
		}

		// Update stacks
		history_stack = remaining_history;

		// Navigate to previous tab
		const result = editor.tabs.navigate_to_tab(previous_id);
		if (result.resulting_tab_id) {
			// If we got back a different tab id (preview was created),
			// update the current_id and replace the id in the future stack
			if (result.resulting_tab_id !== previous_id) {
				current_id = result.resulting_tab_id;

				// Replace previous_id with the new tab id in any history stacks
				future_stack = future_stack.map((id) =>
					id === previous_id ? result.resulting_tab_id! : id,
				);
			} else {
				current_id = result.resulting_tab_id;
			}
		}
	};

	const go_forward = () => {
		if (!can_go_forward) return;

		// Get the next tab from future stack
		const next_id = future_stack[0];
		if (!next_id) return; // Defensive check

		const remaining_future = future_stack.slice(1);

		// Push current tab to history stack
		if (current_id) {
			history_stack = [current_id, ...history_stack];
		}

		// Update stacks
		future_stack = remaining_future;

		// Navigate to next tab
		const result = editor.tabs.navigate_to_tab(next_id);
		if (result.resulting_tab_id) {
			// If we got back a different tab id (preview was created),
			// update the current_id and replace the id in the history stack
			if (result.resulting_tab_id !== next_id) {
				current_id = result.resulting_tab_id;

				// Replace next_id with the new tab id in any history stacks
				history_stack = history_stack.map((id) => (id === next_id ? result.resulting_tab_id! : id));
			} else {
				current_id = result.resulting_tab_id;
			}
		}
	};
</script>

<div class="browser_nav display:flex gap_xs">
	<button
		type="button"
		class="icon_button plain p_xs border_radius_lg"
		title="previous diskfile"
		onclick={go_back}
		disabled={!can_go_back}
	>
		<Glyph glyph={GLYPH_ARROW_LEFT} />
	</button>
	<button
		type="button"
		class="icon_button plain p_xs border_radius_lg"
		title="next diskfile"
		onclick={go_forward}
		disabled={!can_go_forward}
	>
		<Glyph glyph={GLYPH_ARROW_RIGHT} />
	</button>
	<button
		type="button"
		class="icon_button plain p_xs border_radius_lg"
		title="refresh from disk"
		onclick={() => {
			// TODO need to implement the server action to refresh the content from disk
			editor_state;
		}}
		disabled
	>
		<Glyph glyph={GLYPH_REFRESH} />
	</button>
</div>

<style>
	.browser_nav {
		display: flex;
		align-items: center;
	}
</style>

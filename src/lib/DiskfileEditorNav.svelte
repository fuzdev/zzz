<script lang="ts">
	import { icon_arrow_left, icon_arrow_right, icon_refresh } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';

	const {
		editor_state
	}: {
		editor_state: DiskfileEditorState;
	} = $props();

	const app = frontend_context.get();
	// the history lives on the tabs, so it survives this component remounting per file
	const { tabs } = app.diskfiles.editor;
</script>

<div class="flex gap_xs align-items:center">
	<button
		type="button"
		class="icon-button plain p_xs border_radius_lg"
		title="previous diskfile"
		onclick={() => app.intents.tab_back()}
		disabled={!tabs.can_go_back}
	>
		<Icon data={icon_arrow_left} />
	</button>
	<button
		type="button"
		class="icon-button plain p_xs border_radius_lg"
		title="next diskfile"
		onclick={() => app.intents.tab_forward()}
		disabled={!tabs.can_go_forward}
	>
		<Icon data={icon_arrow_right} />
	</button>
	<button
		type="button"
		class="icon-button plain p_xs border_radius_lg"
		title="refresh from disk"
		onclick={() => {
			// TODO need to implement the server action to refresh the content from disk
			editor_state;
		}}
		disabled
	>
		<Icon data={icon_refresh} />
	</button>
</div>

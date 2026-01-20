<script lang="ts">
	import type {PartUnion} from './part.svelte.js';
	import XmlTagControls from './XmlTagControls.svelte';
	import PartStats from './PartStats.svelte';
	import Glyph from './Glyph.svelte';
	import {get_part_type_glyph} from './part_helpers.js';
	import PartEditorForText from './PartEditorForText.svelte';
	import PartContextmenu from './PartContextmenu.svelte';
	import PartEditorForDiskfile from './PartEditorForDiskfile.svelte';
	import PartToggleButton from './PartToggleButton.svelte';
	import PartRemoveButton from './PartRemoveButton.svelte';
	import {frontend_context} from './frontend.svelte.js';

	const {
		part,
		show_actions = true,
	}: {
		part: PartUnion;
		show_actions?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();
	const {prompts} = app;
</script>

<PartContextmenu {part}>
	<div class="column gap_sm" class:dormant={!part.enabled}>
		<div class="display:flex mb_0 justify-content:space-between">
			<div class="font_size_lg m_0">
				<Glyph glyph={get_part_type_glyph(part)} />&nbsp;
				{part.name}
			</div>
			<div class="display:flex gap_xs">
				<PartToggleButton {part} />
				<PartRemoveButton {part} {prompts} />
			</div>
		</div>

		<div>
			{#if part.type === 'text'}
				<PartEditorForText text_part={part} {show_actions} />
			{:else if part.type === 'diskfile'}
				<PartEditorForDiskfile diskfile_part={part} {show_actions} />
			{/if}
		</div>

		<PartStats {part} />
		<XmlTagControls {part} />
	</div>
</PartContextmenu>

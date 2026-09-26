<script lang="ts">
	import type { PartUnion } from './part.svelte.ts';
	import XmlTagControls from './XmlTagControls.svelte';
	import PartStats from './PartStats.svelte';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import { get_part_type_icon, type PartOwner } from './part_helpers.ts';
	import PartEditorForText from './PartEditorForText.svelte';
	import PartContextmenu from './PartContextmenu.svelte';
	import PartEditorForDiskfile from './PartEditorForDiskfile.svelte';
	import PartToggleButton from './PartToggleButton.svelte';
	import PartRemoveButton from './PartRemoveButton.svelte';

	const {
		part,
		owner,
		show_actions = true
	}: {
		part: PartUnion;
		/** What the part belongs to — without one, the part can't be removed from here. */
		owner?: PartOwner | undefined;
		show_actions?: boolean | undefined;
	} = $props();
</script>

<PartContextmenu {part} {owner}>
	<div class="column gap_sm" class:dormant={!part.enabled}>
		<div class="display:flex mb_0 justify-content:space-between">
			<div class="font_size_lg m_0">
				<Svg data={get_part_type_icon(part)} />&nbsp;
				{part.name}
			</div>
			<div class="display:flex gap_xs">
				<PartToggleButton {part} />
				{#if owner}
					<PartRemoveButton {part} {owner} />
				{/if}
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

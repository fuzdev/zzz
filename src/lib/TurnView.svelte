<script lang="ts">
	import type {Turn} from './turn.svelte.js';
	import PartStats from './PartStats.svelte';
	import Glyph from './Glyph.svelte';
	import {get_part_type_glyph} from './part_helpers.js';
	import PartEditorForText from './PartEditorForText.svelte';
	import TurnContextmenu from './TurnContextmenu.svelte';
	import PartEditorForDiskfile from './PartEditorForDiskfile.svelte';
	import PartToggleButton from './PartToggleButton.svelte';
	import PartRemoveButton from './PartRemoveButton.svelte';
	import {frontend_context} from './frontend.svelte.js';

	const {
		turn,
		show_actions = true,
	}: {
		turn: Turn;
		show_actions?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();
	const {prompts} = app;
</script>

<TurnContextmenu {turn}>
	{#if turn.parts.length > 0}
		{#each turn.parts as part (part.id)}
			<div class="column gap_sm mb_md" class:dormant={!part.enabled}>
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
			</div>
		{/each}
	{:else}
		<div class="p_sm">
			{#if turn.part_ids.length > 0}
				parts not found: <code>{turn.part_ids.join(', ')}</code>
			{:else}
				no parts in turn
			{/if}
		</div>
	{/if}
</TurnContextmenu>

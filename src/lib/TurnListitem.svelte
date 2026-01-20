<script lang="ts">
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import ErrorMessageInline from './ErrorMessageInline.svelte';
	import type {Turn} from './turn.svelte.js';
	import {UNKNOWN_ERROR_MESSAGE} from './constants.js';
	import TurnContextmenu from './TurnContextmenu.svelte';

	const {
		turn,
	}: {
		turn: Turn;
	} = $props();
</script>

<TurnContextmenu {turn}>
	<div
		class="px_sm py_xl"
		class:user={turn.role === 'user'}
		class:assistant={turn.role === 'assistant'}
		class:system={turn.role === 'system'}
		class:dormant={!turn.enabled}
	>
		<div class="white-space:pre-wrap overflow-wrap:break-word">
			<small class="mr_xs font-weight:600" title={turn.created}>@{turn.role}:</small>
			{#if turn.pending}
				<PendingAnimation inline />
			{:else if turn.error_message}
				<ErrorMessageInline>{turn.error_message}</ErrorMessageInline>
			{:else if turn.is_content_loaded}
				{turn.content}
			{:else if turn.parts.length === 0}
				<span class="text_color_4 font_family_mono">missing parts: {turn.part_ids.join(', ')}</span>
			{:else}
				<ErrorMessageInline>{UNKNOWN_ERROR_MESSAGE}</ErrorMessageInline>
			{/if}
		</div>
	</div>
</TurnContextmenu>

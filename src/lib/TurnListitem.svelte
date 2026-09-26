<script lang="ts">
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import ErrorMessageInline from './ErrorMessageInline.svelte';
	import type { Turn } from './turn.svelte.ts';
	import { UNKNOWN_ERROR_MESSAGE } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
	import TurnContextmenu from './TurnContextmenu.svelte';

	const {
		turn
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
			{:else if turn.is_content_loaded}
				{turn.content}
			{:else if turn.parts.length === 0}
				<span class="text_60 font_family_mono">missing parts: {turn.part_ids.join(', ')}</span>
			{:else}
				<ErrorMessageInline>{UNKNOWN_ERROR_MESSAGE}</ErrorMessageInline>
			{/if}
		</div>
		{#if turn.error_message}
			<div><ErrorMessageInline>{turn.error_message}</ErrorMessageInline></div>
		{:else if turn.cancelled}
			<div><small class="text_60">stopped</small></div>
		{:else if turn.truncation === 'context_window'}
			<div>
				<small
					class="text_60"
					title="the reply filled the model's context window and is incomplete"
				>
					truncated (context window)
				</small>
			</div>
		{:else if turn.truncation}
			<div>
				<small class="text_60" title="the reply hit the output token limit and is incomplete">
					truncated (max tokens)
				</small>
			</div>
		{/if}
	</div>
</TurnContextmenu>

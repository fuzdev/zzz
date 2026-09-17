<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import type { Thread } from './thread.svelte.ts';
	import { frontend_context } from './frontend.svelte.ts';
	import { icon_delete, icon_model, icon_remove, icon_thread } from '@fuzdev/fuz_ui/icons.ts';
	import ContextmenuEntryToggle from './ContextmenuEntryToggle.svelte';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import ModelPickerDialog from './ModelPickerDialog.svelte';

	const {
		thread,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		thread: Thread;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	let show_model_picker = $state.raw(false);
</script>

<Contextmenu {...rest} {entries} />

<ModelPickerDialog
	bind:show={show_model_picker}
	onpick={(model) => {
		if (model) {
			thread.switch_model(model.id);
		}
	}}
/>

{#snippet entries()}
	<ContextmenuSubmenu icon={icon_thread}>
		thread
		{#snippet menu()}
			{#if thread.content}
				<ContextmenuEntryCopyToClipboard
					content={thread.content}
					label="copy conversation"
					preview={thread.content_preview}
				/>
			{/if}

			{#if thread.turns.size > 0}
				<ContextmenuEntry
					icon={icon_remove}
					run={() => {
						thread.remove_all_turns();
					}}
				>
					<span>clear conversation</span>
				</ContextmenuEntry>
			{/if}

			<ContextmenuEntryToggle bind:enabled={thread.enabled} label="thread" />

			<ContextmenuEntry
				icon={icon_model}
				run={() => {
					show_model_picker = true;
				}}
			>
				switch model &nbsp; <small>{thread.model_name}</small>
			</ContextmenuEntry>

			<ContextmenuEntry
				icon={icon_delete}
				run={() => {
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete this thread?`)) {
						app.threads.remove(thread.id);
					}
				}}
			>
				<span>delete thread</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

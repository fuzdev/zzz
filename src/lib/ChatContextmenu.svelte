<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import type { Chat } from './chat.svelte.ts';
	import { frontend_context } from './frontend.svelte.ts';
	import {
		icon_add,
		icon_chat,
		icon_delete,
		icon_remove,
		icon_view
	} from '@fuzdev/fuz_ui/icons.ts';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import ModelPickerDialog from './ModelPickerDialog.svelte';

	const {
		chat,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		chat: Chat;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();

	let show_model_picker = $state.raw(false);
</script>

<Contextmenu {...rest} {entries} />

{#snippet entries()}
	<ContextmenuSubmenu icon={icon_chat}>
		chat
		{#snippet menu()}
			<ContextmenuEntry
				icon={icon_add}
				run={() => {
					show_model_picker = true;
				}}
			>
				<span>add thread</span>
			</ContextmenuEntry>

			<ContextmenuEntry
				icon={icon_view}
				run={() => {
					chat.view_mode = chat.view_mode === 'simple' ? 'multi' : 'simple';
				}}
			>
				<span>{chat.view_mode === 'simple' ? 'multi' : 'simple'} view</span>
			</ContextmenuEntry>

			<!-- TODO @many maybe a copy submenu on this item with copy id, name, etc, leverage generic cells -->
			<ContextmenuEntryCopyToClipboard content={chat.id} label="copy id" />

			{#if chat.threads.length}
				<ContextmenuEntry icon={icon_remove} run={() => chat.remove_all_threads()}>
					<span>remove all threads</span>
				</ContextmenuEntry>
			{/if}

			{#if chat.main_input}
				<ContextmenuEntryCopyToClipboard
					content={chat.main_input}
					label="copy input"
					preview_limit={30}
				/>

				<ContextmenuEntry
					icon={icon_remove}
					run={() => {
						chat.main_input = '';
					}}
				>
					<span>clear input</span>
				</ContextmenuEntry>
			{/if}

			<!-- TODO I think the best UX here is to have a dialog for the chat editor,
			 focusing the editable input doesn't work outside of the ChatView  -->
			<!-- <ContextmenuEntry
				icon={icon_edit}
				run={() => {
					// TODO make this focus the `EditableText` if available, somehow
					const new_name = prompt('Enter new name for chat:', chat.name); // eslint-disable-line no-alert
					if (new_name && new_name !== chat.name) {
						chat.name = new_name;
					}
				}}
			>
				<span>edit chat</span>
			</ContextmenuEntry> -->

			<ContextmenuEntry
				icon={icon_chat}
				run={async () => {
					// TODO make it have a unique name, and adding threads looks hacky,
					// maybe add a `chats.duplicate` method
					const new_chat = app.chats.add_chat(chat.clone());
					// TODO hacky
					for (const thread of chat.threads) {
						if (thread.model) new_chat.add_thread(thread.model);
					}

					// Select the new chat
					await app.chats.navigate_to(new_chat.id);
				}}
			>
				<span>duplicate chat</span>
			</ContextmenuEntry>

			<ContextmenuEntry
				icon={icon_delete}
				run={() => {
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete the chat "${chat.name}"?`)) {
						app.chats.remove(chat.id);
					}
				}}
			>
				<span>delete chat</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}

<ModelPickerDialog
	bind:show={show_model_picker}
	onpick={(model) => {
		if (model) {
			chat.add_thread(model); // TODO @many insert at an index via a range input
		}
	}}
/>

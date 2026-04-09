<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import type {Chat} from './chat.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import {GLYPH_CHAT, GLYPH_DELETE, GLYPH_REMOVE, GLYPH_VIEW, GLYPH_ADD} from './glyphs.js';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';
	import ModelPickerDialog from './ModelPickerDialog.svelte';
	import Glyph from './Glyph.svelte';

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
	<ContextmenuSubmenu>
		{#snippet icon()}<Glyph glyph={GLYPH_CHAT} />{/snippet}
		chat
		{#snippet menu()}
			<ContextmenuEntry
				run={() => {
					show_model_picker = true;
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_ADD} />{/snippet}
				<span>add thread</span>
			</ContextmenuEntry>

			<ContextmenuEntry
				run={() => {
					chat.view_mode = chat.view_mode === 'simple' ? 'multi' : 'simple';
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_VIEW} />{/snippet}
				<span>{chat.view_mode === 'simple' ? 'multi' : 'simple'} view</span>
			</ContextmenuEntry>

			<!-- TODO @many maybe a copy submenu on this item with copy id, name, etc, leverage generic cells -->
			<ContextmenuEntryCopyToClipboard content={chat.id} label="copy id" />

			{#if chat.threads.length}
				<ContextmenuEntry run={() => chat.remove_all_threads()}>
					{#snippet icon()}<Glyph glyph={GLYPH_REMOVE} />{/snippet}
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
					run={() => {
						chat.main_input = '';
					}}
				>
					{#snippet icon()}<Glyph glyph={GLYPH_REMOVE} />{/snippet}
					<span>clear input</span>
				</ContextmenuEntry>
			{/if}

			<!-- TODO I think the best UX here is to have a dialog for the chat editor,
			 focusing the editable input doesn't work outside of the ChatView  -->
			<!-- <ContextmenuEntry
				run={() => {
					// TODO make this focus the `EditableText` if available, somehow
					const new_name = prompt('Enter new name for chat:', chat.name); // eslint-disable-line no-alert
					if (new_name && new_name !== chat.name) {
						chat.name = new_name;
					}
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_EDIT} />{/snippet}
				<span>edit chat</span>
			</ContextmenuEntry> -->

			<ContextmenuEntry
				run={async () => {
					// TODO make it have a unique name, and adding threads looks hacky,
					// maybe add a `chats.duplicate` method
					const new_chat = app.chats.add_chat(chat.clone());
					// TODO hacky
					for (const thread of chat.threads) {
						new_chat.add_thread(thread.model);
					}

					// Select the new chat
					await app.chats.navigate_to(new_chat.id);
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_CHAT} />{/snippet}
				<span>duplicate chat</span>
			</ContextmenuEntry>

			<ContextmenuEntry
				run={() => {
					// TODO @many better confirmation
					// eslint-disable-next-line no-alert
					if (confirm(`Are you sure you want to delete the chat "${chat.name}"?`)) {
						app.chats.remove(chat.id);
					}
				}}
			>
				{#snippet icon()}<Glyph glyph={GLYPH_DELETE} />{/snippet}
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

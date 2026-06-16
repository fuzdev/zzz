<script lang="ts">
	import {slide} from 'svelte/transition';

	import ChatListitem from './ChatListitem.svelte';
	import {frontend_context} from './frontend.svelte.ts';
	import {sort_by_text, sort_by_numeric} from './sortable.svelte.ts';
	import type {Chat} from './chat.svelte.ts';
	import SortableList from './SortableList.svelte';

	const app = frontend_context.get();
	const {chats} = app;
	const selected_chat_id = $derived(chats.selected_id);
</script>

<SortableList
	items={chats.ordered_items}
	show_sort_controls={chats.show_sort_controls}
	sorters={[
		sort_by_numeric<Chat>('updated_newest', 'updated (latest)', 'updated', 'desc'),
		sort_by_numeric<Chat>('updated_oldest', 'updated (past)', 'updated', 'asc'),
		sort_by_numeric<Chat>('created_newest', 'created (newest)', 'created', 'desc'),
		sort_by_numeric<Chat>('created_oldest', 'created (oldest)', 'created', 'asc'),
		sort_by_text<Chat>('name_asc', 'name (a-z)', 'name'),
		sort_by_text<Chat>('name_desc', 'name (z-a)', 'name', 'desc'),
	]}
	sort_key_default="updated_newest"
>
	{#snippet children(chat)}
		<div transition:slide>
			<ChatListitem {chat} selected={chat.id === selected_chat_id} />
		</div>
	{/snippet}
</SortableList>

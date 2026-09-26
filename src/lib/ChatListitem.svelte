<script lang="ts">
	import { resolve } from '$app/paths';

	import NavLink from './NavLink.svelte';
	import ChatContextmenu from './ChatContextmenu.svelte';
	import { icon_chat } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import type { Chat } from './chat.svelte.ts';

	const {
		chat,
		selected
	}: {
		chat: Chat;
		selected?: boolean | undefined;
	} = $props();
</script>

<ChatContextmenu {chat}>
	<NavLink
		href={resolve(`/chats/${chat.id}`)}
		{selected}
		class="justify-content:space-between"
		style="min-height: 0;"
	>
		<div class="ellipsis">
			<Icon data={icon_chat} />&nbsp;
			<span>{chat.name}</span>
		</div>
		{#if chat.threads.length}<small>{chat.threads.length}</small>{/if}
	</NavLink>
</ChatContextmenu>

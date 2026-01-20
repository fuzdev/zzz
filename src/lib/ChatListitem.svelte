<script lang="ts">
	import {resolve} from '$app/paths';

	import NavLink from './NavLink.svelte';
	import ChatContextmenu from './ChatContextmenu.svelte';
	import Glyph from './Glyph.svelte';
	import {GLYPH_CHAT} from './glyphs.js';
	import type {Chat} from './chat.svelte.js';

	const {
		chat,
		selected,
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
			<Glyph glyph={GLYPH_CHAT} />&nbsp;
			<span>{chat.name}</span>
		</div>
		{#if chat.threads.length}<small>{chat.threads.length}</small>{/if}
	</NavLink>
</ChatContextmenu>

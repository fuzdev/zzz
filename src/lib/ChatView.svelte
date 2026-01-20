<script lang="ts">
	import {slide} from 'svelte/transition';
	import Details from '@fuzdev/fuz_ui/Details.svelte';

	import Glyph from './Glyph.svelte';
	import ConfirmButton from './ConfirmButton.svelte';
	import {Chat} from './chat.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import {GLYPH_THREAD, GLYPH_CHAT, GLYPH_DELETE, GLYPH_VIEW} from './glyphs.js';
	import ThreadList from './ThreadList.svelte';
	import ChatViewSimple from './ChatViewSimple.svelte';
	import ChatViewMulti from './ChatViewMulti.svelte';
	import ToggleButton from './ToggleButton.svelte';
	import ChatInitializer from './ChatInitializer.svelte';
	import ChatThreadAddByModel from './ChatThreadAddByModel.svelte';
	import ChatThreadManageByTag from './ChatThreadManageByTag.svelte';
	import EditableText from './EditableText.svelte';

	const app = frontend_context.get();
	const {chats} = app;

	const {
		chat,
	}: {
		chat: Chat;
	} = $props();

	const thread_count = $derived(chat.threads.length);

	// TODO the add by model stuff is too noisy/overwhelming, needs some redesign

	// TODO add `presets` section to the top with the custom buttons/sets (accessible via contextmenu)
	// TODO custom buttons section - including quick local, smartest all, all, etc - custom buttons to do common things, compose them with buttons like "fill all" or "fill with tag" or at least drag
</script>

<div class="flex:1 height:100% display:flex align-items:start">
	<div class="column_fixed">
		{#if chat}
			<section class="column_section" transition:slide>
				<!-- TODO needs work -->
				<div class="font_size_lg display:flex align-items:center">
					<Glyph glyph={GLYPH_CHAT} />
					<EditableText bind:value={chat.name} />
				</div>
				<div class="row">
					<small class="flex:1" title={chat.created_formatted_datetime}
						>created {chat.created_formatted_short_date}</small
					>
					<div class="row gap_xs py_xs">
						{#if thread_count}
							<ToggleButton
								bind:active={
									() => chat.view_mode === 'simple',
									(active) => (chat.view_mode = active ? 'simple' : 'multi')
								}
								active_content="simple"
								inactive_content="multi"
								class="plain compact"
								title="toggle chat to ${chat.view_mode === 'multi' ? 'simple' : 'multi'} view"
							>
								<Glyph glyph={GLYPH_VIEW} class="mr_xs" />
							</ToggleButton>
						{/if}
						<ConfirmButton
							onconfirm={() => chat.id && chats.remove(chat.id)}
							title="delete chat {'"' + chat.name + '"'}"
							class="plain icon_button"
						>
							<Glyph glyph={GLYPH_DELETE} />
							{#snippet popover_button_content()}<Glyph glyph={GLYPH_DELETE} />{/snippet}
						</ConfirmButton>
					</div>
				</div>
			</section>
		{/if}

		{#if thread_count && (chat.view_mode !== 'simple' || thread_count > 1)}
			<section class="column_section">
				<header
					class="mt_0 mb_lg font_size_lg display:flex justify-content:space-between"
					title="threads are the individual threads of conversation in a chat -- each chat can have many threads, comprising its history"
				>
					<span><Glyph glyph={GLYPH_THREAD} /> threads</span><span>{thread_count}</span>
				</header>
				<ThreadList {chat} />
			</section>
			<!-- TODO consider a UX that lets users pin arbitrary prompts/parts/etc to each chat -->
		{/if}

		{#if chat.view_mode === 'multi'}
			<Details>
				{#snippet summary()}manage threads{/snippet}
				<section class="column_section">
					<ChatThreadAddByModel {chat} />
				</section>
				<section class="column_section">
					<ChatThreadManageByTag {chat} />
				</section>
			</Details>
		{/if}
	</div>

	{#if !thread_count}
		<div class="column_fluid p_md">
			<ChatInitializer {chat} oninit={(chat_id) => chats.navigate_to(chat_id)} />
		</div>
	{:else if chat.view_mode === 'simple'}
		<ChatViewSimple {chat} thread={chat.current_thread} />
	{:else}
		<ChatViewMulti {chat} />
	{/if}
</div>

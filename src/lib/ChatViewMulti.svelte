<script lang="ts">
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import {slide} from 'svelte/transition';

	import ConfirmButton from './ConfirmButton.svelte';
	import {Chat} from './chat.svelte.js';
	import ChatThread from './ChatThread.svelte';
	import {GLYPH_ADD, GLYPH_PLACEHOLDER, GLYPH_REMOVE, GLYPH_SEND} from './glyphs.js';
	import ContentEditor from './ContentEditor.svelte';
	import ModelPickerDialog from './ModelPickerDialog.svelte';
	import Glyph from './Glyph.svelte';

	const {
		chat,
	}: {
		chat: Chat;
	} = $props();

	let content_input: {focus: () => void} | undefined;
	let pending = $state(false); // TODO refactor request state

	const send_to_all = async () => {
		if (!count) return;
		const parsed = chat.main_input.trim();
		if (!parsed) {
			content_input?.focus();
			return;
		}
		chat.main_input = '';
		pending = true;
		await chat.send_to_all(parsed);
		pending = false;
	};

	const count = $derived(chat.enabled_threads.length);

	let show_model_picker = $state(false);
</script>

<div class="column_fluid">
	<div class="column_bg_1 p_sm">
		<ContentEditor
			bind:this={content_input}
			bind:content={chat.main_input}
			token_count={chat.main_input_token_count}
			placeholder="{GLYPH_PLACEHOLDER} to {count}"
			show_actions
			show_stats
			focus_key={chat.id}
			bind:pending_element_to_focus_key={
				() => chat.app.ui.pending_element_to_focus_key,
				(v) => {
					chat.app.ui.pending_element_to_focus_key = v;
				}
			}
		>
			<PendingButton
				{pending}
				onclick={send_to_all}
				disabled={!count ? true : undefined}
				class="plain"
			>
				<Glyph glyph={GLYPH_SEND} /> to {count}
			</PendingButton>
		</ContentEditor>

		<div class="display:flex mt_lg">
			<button type="button" class="plain" onclick={() => (show_model_picker = true)}>
				<Glyph glyph={GLYPH_ADD} />&nbsp; add thread
			</button>
			<ConfirmButton
				onconfirm={() => chat.remove_all_threads()}
				position="right"
				disabled={!count}
				class="plain"><Glyph glyph={GLYPH_REMOVE} />&nbsp; remove all</ConfirmButton
			>
		</div>
		<ul class="threads unstyled mt_lg">
			{#each chat.threads as thread (thread.id)}
				<li in:slide>
					<ChatThread
						{thread}
						onsend={(input) => chat.send_to_thread(thread.id, input)}
						turns_attrs={{class: 'max_height_sm'}}
						attrs={{class: 'p_md'}}
					/>
				</li>
			{/each}
		</ul>
	</div>
</div>

<ModelPickerDialog
	bind:show={show_model_picker}
	onpick={(model) => {
		if (model) {
			chat.add_thread(model); // TODO @many insert at an index via a range input
		}
	}}
/>

<style>
	.threads {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: var(--space_md);
	}
</style>

<script lang="ts">
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {tick} from 'svelte';
	import type {SvelteHTMLElements} from 'svelte/elements';

	import {estimate_token_count} from './helpers.js';
	import type {Thread} from './thread.svelte.js';
	import ModelPickerDialog from './ModelPickerDialog.svelte';
	import TurnList from './TurnList.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import ThreadContextmenu from './ThreadContextmenu.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import ContentEditor from './ContentEditor.svelte';
	import {GLYPH_ERROR, GLYPH_PLACEHOLDER, GLYPH_SEND} from './glyphs.js';
	import Glyph from './Glyph.svelte';

	// TODO no longer uses `Chat`, maybe rename to `ThreadView` or similar?

	let {
		thread,
		onsend,
		focus_key,
		pending_element_to_focus_key = $bindable(),
		turns_attrs,
		attrs,
	}: {
		thread: Thread;
		onsend: (input: string) => Promise<void>;
		// TODO @many think about how these two could be refactored, like a single class instance
		focus_key?: string | number | null | undefined;
		pending_element_to_focus_key?: string | number | null | undefined;
		turns_attrs?: SvelteHTMLElements['div'] | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	let input = $state('');
	const input_token_count = $derived(estimate_token_count(input));
	let content_input: {focus: () => void} | undefined;
	let pending = $state(false);

	const send = async () => {
		const parsed = input.trim();
		if (!parsed) {
			content_input?.focus();
			return;
		}
		input = '';
		void tick().then(() => content_input?.focus()); // timeout is maybe unnecessary, lets the input clear first to maybe avoid a frame of jank
		pending = true;
		await onsend(parsed);
		pending = false;
	};

	const turn_count = $derived(thread.turns.size);

	const empty = $derived(!turn_count);

	let show_model_picker = $state(false);

	// Show loading indicator for local models (Ollama) when they're not loaded
	const is_local_model = $derived(thread.model.provider_name === 'ollama');
	const show_loading_indicator = $derived(is_local_model && !thread.model.loaded);

	const provider = $derived(thread.model.provider);
	const provider_error = $derived(
		provider?.available
			? null
			: provider?.status && !provider.status.available
				? provider.status.error
				: 'provider unavailable',
	);
	const send_disabled = $derived(pending || !!provider_error);
</script>

<ModelContextmenu model={thread.model}>
	<ThreadContextmenu {thread}>
		<div {...attrs} class="chat_thread {attrs?.class}" class:empty class:dormant={!thread.enabled}>
			<div class="display:flex justify-content:space-between align-items:start">
				<header>
					<button
						type="button"
						class="plain compact font_size_lg text-align:left font-weight:400"
						onclick={() => (show_model_picker = true)}
					>
						{thread.model.name}
						{#if show_loading_indicator}
							<span class="ml_xs3" title="model loading">
								<PendingAnimation inline />
							</span>
						{/if}
					</button>
					<small
						><ProviderLink
							{provider}
							icon="svg"
							icon_props={{size: 'var(--font_size_sm)'}}
							show_name
						/>{#if provider_error}<span class="color_c_5 ml_sm"
								><Glyph glyph={GLYPH_ERROR} /> {provider_error}</span
							>{/if}</small
					>
				</header>
				<!-- TODO maybe add a button here that opens the contextmenu? -->
			</div>

			{#if turn_count}
				<TurnList {thread} attrs={turns_attrs} />
			{/if}

			<div>
				<ContentEditor
					bind:this={content_input}
					bind:content={input}
					token_count={input_token_count}
					placeholder={GLYPH_PLACEHOLDER}
					show_stats
					show_actions
					{focus_key}
					bind:pending_element_to_focus_key
				>
					<PendingButton
						{pending}
						disabled={send_disabled}
						onclick={send}
						class="plain {provider_error ? ' color_c_5' : ''}"
						title={provider?.available
							? `send ${input_token_count} tokens to ${thread.model_name}`
							: (provider_error ?? undefined)}
					>
						<Glyph glyph={GLYPH_SEND} />
					</PendingButton>
				</ContentEditor>
			</div>
		</div>

		<ModelPickerDialog
			bind:show={show_model_picker}
			onpick={(model) => {
				if (model) {
					thread.switch_model(model.id);
				}
			}}
		/>
	</ThreadContextmenu>
</ModelContextmenu>

<style>
	.chat_thread {
		display: flex;
		flex-direction: column;
		gap: var(--space_md);
		background-color: var(--bg);
		border-radius: var(--border_radius_xs);
	}

	.chat_thread.empty {
		justify-content: center;
	}
</style>

<script lang="ts">
	import PendingButton from '@fuzdev/fuz_ui/PendingButton.svelte';
	import { tick } from 'svelte';
	import type { SvelteHTMLElements } from 'svelte/elements';

	import { estimate_token_count, format_placeholder } from './helpers.ts';
	import type { Thread } from './thread.svelte.ts';
	import ModelPickerDialog from './ModelPickerDialog.svelte';
	import TurnList from './TurnList.svelte';
	import ProviderLink from './ProviderLink.svelte';
	import ThreadContextmenu from './ThreadContextmenu.svelte';
	import ModelContextmenu from './ModelContextmenu.svelte';
	import ContentEditor from './ContentEditor.svelte';
	import { icon_error, icon_send, icon_stop } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	// TODO no longer uses `Chat`, maybe rename to `ThreadView` or similar?

	let {
		thread,
		onsend,
		focus_key,
		pending_element_to_focus_key = $bindable(),
		turns_attrs,
		attrs
	}: {
		thread: Thread;
		onsend: (input: string) => Promise<void>;
		// TODO @many think about how these two could be refactored, like a single class instance
		focus_key?: string | number | null | undefined;
		pending_element_to_focus_key?: string | number | null | undefined;
		turns_attrs?: SvelteHTMLElements['div'] | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	let input = $state.raw('');
	const input_token_count = $derived(estimate_token_count(input));
	let content_input: { focus: () => void } | undefined;

	const send = async () => {
		const parsed = input.trim();
		if (!parsed) {
			content_input?.focus();
			return;
		}
		input = '';
		void tick().then(() => content_input?.focus()); // timeout is maybe unnecessary, lets the input clear first to maybe avoid a frame of jank
		await onsend(parsed);
	};

	const turn_count = $derived(thread.turns.size);

	const empty = $derived(!turn_count);

	let show_model_picker = $state.raw(false);

	const provider = $derived(thread.model?.provider);
	const provider_error = $derived(
		provider?.available
			? null
			: provider?.status && !provider.status.available
				? provider.status.error
				: 'provider unavailable'
	);
	const send_disabled = $derived(thread.pending || !!provider_error);
</script>

<ModelContextmenu model={thread.model}>
	<ThreadContextmenu {thread}>
		<div
			{...attrs}
			class="chat-thread column gap_md shade_00 border_radius_xs {attrs?.class}"
			class:empty
			class:dormant={!thread.enabled}
		>
			<div class="display:flex justify-content:space-between align-items:start">
				<header>
					<button
						type="button"
						class="plain sm font_size_lg text-align:left font-weight:400"
						onclick={() => (show_model_picker = true)}
					>
						{thread.model?.name ?? thread.model_name}
					</button>
					<small
						><ProviderLink
							{provider}
							icon="logo"
							icon_props={{ size: 'var(--font_size_sm)' }}
							label="name"
						/>{#if provider_error}<span class="palette_c_50 ml_sm"
								><Svg data={icon_error} /> {provider_error}</span
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
					placeholder={format_placeholder()}
					show_stats
					show_actions
					{focus_key}
					bind:pending_element_to_focus_key
				>
					{#if thread.pending}
						<button
							type="button"
							class="plain"
							onclick={() => thread.cancel_pending()}
							title="stop generating"
						>
							<Svg data={icon_stop} />
						</button>
					{:else}
						<PendingButton
							pending={thread.pending}
							disabled={send_disabled}
							onclick={send}
							class="plain {provider_error ? ' palette_c_50' : ''}"
							title={provider?.available
								? `send ${input_token_count} tokens to ${thread.model_name}`
								: (provider_error ?? undefined)}
						>
							<Svg data={icon_send} />
						</PendingButton>
					{/if}
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
	.chat-thread.empty {
		justify-content: center;
	}
</style>

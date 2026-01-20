<script lang="ts">
	// @slop claude_sonnet_4

	import Glyph from './Glyph.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import OllamaActionItem from './OllamaActionItem.svelte';
	import {GLYPH_DOWNLOAD, GLYPH_ARROW_LEFT, GLYPH_PLACEHOLDER} from './glyphs.js';
	import type {Ollama} from './ollama.svelte.js';
	import {frontend_context} from './frontend.svelte.js';

	const {
		ollama,
		onclose,
		oncancel,
	}: {
		ollama: Ollama;
		onclose?: () => void;
		oncancel?: () => void;
	} = $props();

	const app = frontend_context.get();

	const {models_not_downloaded} = $derived(app.ollama);

	const pull_actions = $derived(ollama.actions.filter((a) => a.method === 'ollama_pull')); // TODO index?

	const handle_pull = async () => {
		onclose?.();
		await ollama.pull();
	};

	const handle_keydown = (event: KeyboardEvent) => {
		if (event.key === 'Enter' && ollama.pull_can_pull) {
			void handle_pull();
		} else if (event.key === 'Escape') {
			onclose?.();
		}
	};

	// TODO show req/res times, using actions
</script>

<div class="panel p_md">
	<header class="display:flex justify-content:space-between align-items:center mb_md">
		<h3 class="mt_0 mb_0">
			<Glyph glyph={GLYPH_DOWNLOAD} /> pull model
		</h3>
		<button type="button" class="icon_button plain" onclick={onclose} title="close">
			<Glyph glyph={GLYPH_ARROW_LEFT} />
		</button>
	</header>

	<div class="width_atmost_md display:flex flex-direction:column gap_md">
		<p>This downloads a builtin model so you can use it locally.</p>

		<fieldset>
			<label class="display:block mb_xs">
				<div class="title">model name</div>
				<input
					type="text"
					class="plain width:100%"
					placeholder="{GLYPH_PLACEHOLDER} e.g., llama3.1, mistral, codellama"
					bind:value={ollama.pull_model_name}
					onkeydown={handle_keydown}
				/>
			</label>
			<p>
				Enter a model name from the <a
					href="https://ollama.com/library"
					target="_blank"
					rel="noopener noreferrer">Ollama library</a
				>{#if models_not_downloaded.length > 0}
					&nbsp;or choose from the available models:
				{:else}.{/if}
			</p>
			{#if models_not_downloaded.length > 0}
				<div class="display:flex flex-wrap:wrap gap_xs">
					{#each models_not_downloaded as model (model.id)}
						<button
							type="button"
							class="compact"
							onclick={() => (ollama.pull_model_name = model.name)}
							disabled={ollama.pull_model_name === model.name || ollama.pull_is_pulling(model.name)}
						>
							{model.name}
						</button>
					{/each}
				</div>
			{/if}
		</fieldset>

		<label class="display:flex gap_xs align-items:center">
			<input type="checkbox" class="compact" bind:checked={ollama.pull_insecure} />
			<span>allow insecure connections</span>
		</label>

		<div class="display:flex gap_md">
			<button type="button" class="color_a" disabled={!ollama.pull_can_pull} onclick={handle_pull}>
				<Glyph glyph={GLYPH_DOWNLOAD} />&nbsp; pull model
			</button>
			{#if oncancel}
				<button type="button" class="plain" onclick={() => oncancel()}>cancel</button>
			{/if}
		</div>

		{#if ollama.pull_already_downloaded}
			<ErrorMessage>this model is already downloaded</ErrorMessage>
		{/if}

		{#if pull_actions.length > 0}
			<div class="mt_md">
				<h4 class="mt_0 mb_sm">pull operations</h4>
				<ul class="unstyled">
					{#each pull_actions as action (action.id)}
						<OllamaActionItem {action} />
					{/each}
				</ul>
			</div>
		{/if}
	</div>
</div>

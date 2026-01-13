<script lang="ts">
	// @slop claude_sonnet_4

	import {slide} from 'svelte/transition';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {onMount} from 'svelte';
	import {plural} from '@fuzdev/fuz_util/string.js';

	import Glyph from './Glyph.svelte';
	import ExternalLink from './ExternalLink.svelte';
	import {GLYPH_ADD, GLYPH_COPY, GLYPH_DOWNLOAD, GLYPH_SETTINGS} from './glyphs.js';
	import OllamaConfigure from './OllamaConfigure.svelte';
	import OllamaModelDetail from './OllamaModelDetail.svelte';
	import OllamaPullModel from './OllamaPullModel.svelte';
	import OllamaCreateModel from './OllamaCreateModel.svelte';
	import OllamaCopyModel from './OllamaCopyModel.svelte';
	import OllamaModelListitem from './OllamaModelListitem.svelte';
	import type {Ollama} from './ollama.svelte.js';
	import {frontend_context} from './frontend.svelte.js';

	const {
		ollama,
	}: {
		ollama: Ollama;
	} = $props();

	const app = frontend_context.get();
	const {capabilities} = app;

	// TODO consider "pinning" views so that when others open, they stay open and stable onscreen (but you probably want to rearrange the panels)

	// TODO think about snapshotting/loading this and ollama.svelte.ts data

	// TODO probably should use routes instead of internal state,
	// but I want to see about using this as a snapshotting experiment
	// (with saving/loading the full state, starting at the app, the tree root),
	// there are some nice properties of this approach,
	// that could probably be achieved in other ways too
	// like using SvelteKit's snapshots - https://svelte.dev/docs/kit/snapshots

	onMount(() => {
		void ollama.refresh(); // TODO maybe only if `this.ollama.status === 'initial'` like the capability?

		// TODO @many probably want a different state to capture user intent of enabling polling, but the whole UX may change
		// Start polling for `ps` status if not already started
		const started_polling = !ollama.ps_polling_enabled;
		if (started_polling) {
			ollama.start_ps_polling({immediate: false}); // refresh does this above
		}

		return started_polling
			? () => {
					ollama.stop_ps_polling();
				}
			: undefined;
	});

	const {status} = $derived(capabilities.ollama);
</script>

<div class="display:flex height:100%">
	<!-- sidebar -->
	<div class="height:100% overflow:hidden width_upto_sm width_atleast_sm">
		<div class="height:100% overflow:auto scrollbar-width:thin p_md">
			<!-- status and connection -->
			<section class="display:flex flex-direction:column gap_md">
				<div class="display:flex gap_sm align-items:start">
					<div
						class="flex:1 chip plain display:flex justify-content:start font-weight:400"
						class:color_b={ollama.available}
						class:color_c={!ollama.available && status === 'failure'}
						class:color_d={!ollama.available && status === 'pending'}
						class:color_e={!ollama.available && status === 'initial'}
					>
						<div class="column justify-content:center gap_xs p_md">
							<span class="font_size_lg">
								Ollama {ollama.available
									? `connected`
									: status === 'failure'
										? 'unavailable'
										: status === 'pending'
											? 'connecting'
											: 'not checked'}
								{#if status === 'pending'}
									<PendingAnimation inline class="ml_sm" />
								{/if}
							</span>
							<div class="font_family_mono font_size_sm">
								{#if capabilities.ollama.error_message}
									{capabilities.ollama.error_message}
								{:else if !capabilities.backend_available}
									backend unavailable
								{:else}
									{ollama.host}
									{#if ollama.list_round_trip_time}
										<span> → {Math.round(ollama.list_round_trip_time)}ms</span>
									{/if}
								{/if}
							</div>
						</div>
					</div>
				</div>

				<!-- TODO hacky styles, trying a variant of menu styles here, some of which may be upstreamed (plain doesnt currently mix well with others like menu_item and colors) -->
				<div class="flex-direction:column gap_sm">
					<button
						type="button"
						class="width:100% justify-content:start border_radius_0 plain menu_item selectable font-weight:500"
						class:selected={ollama.manager_selected_view === 'configure'}
						onclick={() => {
							ollama.set_manager_view('configure', null);
						}}
					>
						<Glyph glyph={GLYPH_SETTINGS} />
						<span class="ml_sm">configure</span>
					</button>

					<button
						type="button"
						class="width:100% justify-content:start border_radius_0 plain menu_item selectable font-weight:500"
						class:selected={ollama.manager_selected_view === 'pull'}
						disabled={!ollama.available}
						onclick={() => ollama.set_manager_view('pull', null)}
					>
						<Glyph glyph={GLYPH_DOWNLOAD} />
						<span class="ml_sm">pull model</span>
					</button>

					<button
						type="button"
						class="width:100% justify-content:start border_radius_0 plain menu_item selectable font-weight:500"
						class:selected={ollama.manager_selected_view === 'create'}
						disabled={!ollama.available}
						onclick={() => ollama.set_manager_view('create', null)}
					>
						<Glyph glyph={GLYPH_ADD} />
						<span class="ml_sm">create model</span>
					</button>

					<button
						type="button"
						class="width:100% justify-content:start border_radius_0 plain menu_item selectable font-weight:500"
						class:selected={ollama.manager_selected_view === 'copy'}
						disabled={!ollama.available || ollama.models_downloaded.length === 0}
						onclick={() => ollama.set_manager_view('copy', null)}
					>
						<Glyph glyph={GLYPH_COPY} />
						<span class="ml_sm">copy model</span>
					</button>
				</div>
			</section>

			{#if ollama.models_downloaded.length > 0}
				<!-- downloaded models -->
				<section>
					<h3 class="mt_xl3 mb_md">
						{ollama.models_downloaded.length} model{plural(ollama.models_downloaded.length)}
					</h3>

					<menu class="unstyled column">
						{#each ollama.models_downloaded as model (model.id)}
							<li transition:slide>
								<OllamaModelListitem {model} />
							</li>
						{/each}
					</menu>
				</section>
				<!-- models not downloaded -->
				{#if ollama.models_not_downloaded.length > 0}
					<section>
						<h3 class="mt_xl3 mb_md">
							{ollama.models_not_downloaded.length} not downloaded
						</h3>

						<menu class="unstyled column">
							{#each ollama.models_not_downloaded as model (model.id)}
								<li transition:slide>
									<OllamaModelListitem
										{model}
										onclick={async () => {
											await model.navigate_to_download();
										}}
									/>
								</li>
							{/each}
						</menu>
					</section>
				{/if}
			{:else if ollama.available}
				<section class="panel p_md" transition:slide>
					<p>
						no models found, <button
							type="button"
							class="inline compact"
							disabled={ollama.manager_selected_view === 'pull'}
							onclick={() => ollama.set_manager_view('pull', null)}>pull a model</button
						>
						or install them using the
						<ExternalLink href="https://github.com/ollama/ollama">Ollama CLI</ExternalLink>
					</p>
				</section>
			{/if}
		</div>
	</div>

	<!-- main content -->
	<div class="flex:1 height:100% overflow:auto p_md">
		{#if ollama.manager_selected_view === 'configure'}
			<OllamaConfigure
				{ollama}
				last_active_view={ollama.manager_last_active_view?.view ?? null}
				onshowpull={() => ollama.set_manager_view('pull', null)}
				onback={() => ollama.manager_back_to_last_view()}
			/>
		{:else if ollama.manager_selected_view === 'model' && ollama.manager_selected_model}
			<div class="display:block panel p_md">
				<OllamaModelDetail
					model={ollama.manager_selected_model}
					onshow={(m) => ollama.app.api.ollama_show({model: m.name})}
					onclose={() => ollama.close_form()}
					ondelete={(m) => ollama.delete(m.name)}
				/>
			</div>
		{:else if ollama.manager_selected_view === 'pull'}
			<OllamaPullModel {ollama} oncancel={() => ollama.close_form()} />
		{:else if ollama.manager_selected_view === 'create'}
			<OllamaCreateModel
				{ollama}
				onclose={() => ollama.close_form()}
				onshowpull={() => ollama.set_manager_view('pull', null)}
			/>
		{:else if ollama.manager_selected_view === 'copy'}
			<OllamaCopyModel {ollama} onclose={() => ollama.close_form()} />
		{/if}
	</div>
</div>

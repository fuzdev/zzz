<script lang="ts">
	import {blur, fly, slide} from 'svelte/transition';

	import {DURATION_LG} from './helpers.js';
	import {frontend_context} from './frontend.svelte.js';
	import ExternalLink from './ExternalLink.svelte';

	const app = frontend_context.get();
</script>

{#if app.ui.tutorial_for_chats}
	<div class="pt_lg" out:slide={{delay: DURATION_LG}}>
		<div out:blur={{duration: DURATION_LG}}>
			<aside out:fly={{duration: DURATION_LG, x: -10, y: -1}}>
				<p>
					This currently supports chatting with local models via Ollama, and if you bring your own
					API key, it supports basic text chat with ChatGPT, Claude, and Gemini. It's still early,
					share your ideas in the <ExternalLink href="https://github.com/fuzdev/zzz/discussions"
						>discussions</ExternalLink
					>.
				</p>
				<button
					type="button"
					class="sm"
					onclick={() => {
						app.ui.tutorial_for_chats = false;
					}}>k</button
				>
			</aside>
		</div>
	</div>
{/if}

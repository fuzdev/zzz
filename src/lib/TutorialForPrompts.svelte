<script lang="ts">
	import {blur, fly, slide} from 'svelte/transition';
	import {resolve} from '$app/paths';

	import {DURATION_LG} from './helpers.js';
	import {frontend_context} from './frontend.svelte.js';
	import ExternalLink from './ExternalLink.svelte';

	const app = frontend_context.get();
</script>

{#if app.ui.tutorial_for_prompts}
	<div class="pt_lg" out:slide={{delay: DURATION_LG}}>
		<div out:blur={{duration: DURATION_LG}}>
			<aside out:fly={{duration: DURATION_LG, y: -1, x: 10}}>
				<p>
					The prompt builder UI is very rough. The plan is to experiment with many ideas for making
					and managing prompts, both simpler and more complex than this first iteration. Zzz will
					likewise explore variants of the <a href={resolve('/chats')}>chat</a> interface. Share
					your ideas in the <ExternalLink href="https://github.com/fuzdev/zzz/discussions"
						>discussions</ExternalLink
					>.
				</p>
				<button
					type="button"
					class="sm"
					onclick={() => {
						app.ui.tutorial_for_prompts = false;
					}}>okay</button
				>
			</aside>
		</div>
	</div>
{/if}

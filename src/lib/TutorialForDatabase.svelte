<script lang="ts">
	import {blur, scale, slide} from 'svelte/transition';
	import {sineInOut} from 'svelte/easing';

	import ExternalLink from './ExternalLink.svelte';
	import {DURATION_LG} from './helpers.js';
	import {frontend_context} from './frontend.svelte.js';

	const app = frontend_context.get();
</script>

{#if app.ui.tutorial_for_database}
	<div class="pt_lg" out:slide={{delay: DURATION_LG}}>
		<div out:blur={{duration: DURATION_LG}}>
			<aside out:scale={{duration: DURATION_LG, easing: (t) => sineInOut(t / 3)}}>
				<p>
					⚠️ This is an early prototype and your prompts are not saved yet, they are gone when you
					refresh the page. Soon the Node backend will persist data to a Postgres or pglite
					database. (<ExternalLink href="https://github.com/fuzdev/zzz/issues/7"
						>issue 7</ExternalLink
					>)
				</p>
				<button
					type="button"
					class="sm"
					onclick={() => {
						app.ui.tutorial_for_database = false;
					}}>ok</button
				>
			</aside>
		</div>
	</div>
{/if}

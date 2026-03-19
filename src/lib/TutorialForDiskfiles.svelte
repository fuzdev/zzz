<script lang="ts">
	import {blur, fly, slide} from 'svelte/transition';

	import {DURATION_LG} from './helpers.js';
	import {frontend_context} from './frontend.svelte.js';

	const app = frontend_context.get();
</script>

{#if app.ui.tutorial_for_diskfiles}
	<div class="pt_lg" out:slide={{delay: DURATION_LG}}>
		<div out:blur={{duration: DURATION_LG}}>
			<aside out:fly={{duration: DURATION_LG, x: 10, y: -1}}>
				<p>
					⚠️ This filesystem interface is an early proof of concept and lacks most features you'd
					expect. Some basics work if you're using this with Node, and there will be more soon.
					Chatting creates files, and you can modify and save them, and see the edit history.
				</p>
				<button
					type="button"
					class="sm"
					onclick={() => {
						app.ui.tutorial_for_diskfiles = false;
					}}>ok</button
				>
			</aside>
		</div>
	</div>
{/if}

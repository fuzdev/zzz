<script lang="ts">
	import { blur, fly, slide } from 'svelte/transition';

	import { DURATION_LG } from './helpers.ts';
	import { frontend_context } from './frontend.svelte.ts';

	const app = frontend_context.get();
</script>

{#if app.ui.tutorial_for_diskfiles}
	<div class="pt_lg" out:slide={{ delay: DURATION_LG }}>
		<div out:blur={{ duration: DURATION_LG }}>
			<aside out:fly={{ duration: DURATION_LG, x: 10, y: -1 }}>
				<p>
					⚠️ This filesystem interface is an early proof of concept and lacks most features you'd
					expect. Some basics work, and there will be more soon: you can create files in the app
					directory, edit and save files there, in scoped directories, and in open workspaces, and
					see the edit history.
				</p>
				<button
					type="button"
					class="sm"
					onclick={() => {
						app.ui.tutorial_for_diskfiles = false;
					}}
				>
					ok
				</button>
			</aside>
		</div>
	</div>
{/if}

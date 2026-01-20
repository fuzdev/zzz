<script lang="ts">
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import {frontend_context} from './frontend.svelte.js';

	const app = frontend_context.get();
	const {capabilities} = app;

	const zzz_dir = $derived(app.zzz_dir);
	const scoped_dirs = $derived(app.scoped_dirs);
</script>

<div
	class="chip plain flex:1 font_size_xl px_xl flex-direction:column mb_xl width_atmost_sm"
	style:display="display:flex !important"
	style:align-items="flex-start !important"
	style:font-weight="400 !important"
	class:color_b={capabilities.filesystem.status === 'success'}
	class:color_c={capabilities.filesystem.status === 'failure'}
	class:color_d={capabilities.filesystem.status === 'pending'}
	class:color_e={capabilities.filesystem.status === 'initial'}
>
	<div class="column justify-content:center gap_xs p_md" style:min-height="80px">
		<div class="font_size_xl">
			filesystem {capabilities.filesystem.status === 'success'
				? 'available'
				: capabilities.filesystem.status === 'failure'
					? 'unavailable'
					: capabilities.filesystem.status === 'pending'
						? 'loading'
						: 'not initialized'}
			{#if capabilities.filesystem.status === 'pending'}
				<PendingAnimation inline />
			{/if}
		</div>
		<div class="column gap_xs3 font_family_mono">
			{#if zzz_dir === undefined || zzz_dir === null}
				<small>&nbsp;</small>
			{:else if zzz_dir === ''}
				<small>no zzz directory configured</small>
			{:else}
				<small>{zzz_dir}</small>
			{/if}
			{#each scoped_dirs as dir (dir)}
				<small>{dir}</small>
			{/each}
		</div>
	</div>
</div>

<section>
	<p>
		The backend's filesystem is scoped for security. Symlinks are not followed. Configure with <code
			class="font_size_sm">PUBLIC_ZZZ_DIR</code
		>
		and <code class="font_size_sm">PUBLIC_ZZZ_SCOPED_DIRS</code>.
	</p>
</section>

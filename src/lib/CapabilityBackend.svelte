<script lang="ts">
	import {slide} from 'svelte/transition';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';
	import {onMount} from 'svelte';

	import {frontend_context} from './frontend.svelte.js';
	import Glyph from './Glyph.svelte';
	import {GLYPH_ARROW_RIGHT} from './glyphs.js';
	import ErrorMessage from './ErrorMessage.svelte';
	import {SERVER_URL} from './constants.js';
	import PingForm from './PingForm.svelte';
	import ExternalLink from './ExternalLink.svelte';

	const app = frontend_context.get();
	const {capabilities} = app;

	onMount(() => {
		void capabilities.init_backend_check();
	});
</script>

<div class="display:flex flex-direction:column">
	<div class="display:flex">
		<div
			class="chip px_xl plain font-weight:400 width_atmost_sm"
			style:padding="0 var(--space_xl) !important"
			style:font-weight="400 !important"
			class:color_b={capabilities.backend.status === 'success'}
			class:color_c={capabilities.backend.status === 'failure'}
			class:color_d={capabilities.backend.status === 'pending'}
			class:color_e={capabilities.backend.status === 'initial'}
		>
			<div class="column justify-content:center gap_xs" style:min-height="80px">
				<div class="font_size_xl">
					backend {capabilities.backend.status === 'success'
						? 'available'
						: capabilities.backend.status === 'failure'
							? 'unavailable'
							: capabilities.backend.status === 'pending'
								? 'checking'
								: 'not checked'}
					{#if capabilities.backend.status === 'pending'}
						<PendingAnimation inline />
					{/if}
				</div>
				<small class="font_family_mono"
					>{SERVER_URL}
					{#if capabilities.latest_ping_time !== null}<span
							><Glyph glyph={GLYPH_ARROW_RIGHT} />
							{Math.round(capabilities.latest_ping_time)}ms</span
						>{/if}
				</small>
			</div>
		</div>
	</div>

	{#if capabilities.backend.error_message}
		<div transition:slide>
			<ErrorMessage
				><small class="font_family_mono">{capabilities.backend.error_message}</small></ErrorMessage
			>
		</div>
	{/if}

	<div class="my_lg">
		<p>
			The Zzz backend provides local system access (like to your filesystem), handles API requests
			to AI providers, and enables other capabilities that would otherwise be unavailable to the app
			running in the browser. It's made with <ExternalLink href="https://hono.dev/"
				>Hono</ExternalLink
			>, a JS server framework that aligns with web standards, and <ExternalLink
				href="https://svelte.dev/docs/kit/introduction">SvelteKit</ExternalLink
			>.
		</p>
	</div>

	<PingForm />
</div>

<script lang="ts">
	import {GLYPH_SETTINGS} from './glyphs.js';
	import Glyph from './Glyph.svelte';
	import Settings from './Settings.svelte';
	import {frontend_context} from './frontend.svelte.js';
	import DashboardHeader from './DashboardHeader.svelte';
	import TimeWidget from './TimeWidget.svelte';
	import Footer from './Footer.svelte';

	const app = frontend_context.get();

	// TODO display capabilities (like what APIs are available, including remote server (off when deployed statically), local pglite (could be disconnected, websockets?))
	// TODO display database info/explorer
</script>

<div class="p_lg">
	<DashboardHeader>
		{#snippet header()}
			<h1><Glyph glyph={GLYPH_SETTINGS} /> system settings</h1>
		{/snippet}
		<TimeWidget value={app.time.now} />
	</DashboardHeader>
	<section class="width_atmost_md">
		<Settings />

		<div class="mt_lg">
			<h3>ui</h3>
			<div class="my_md">
				<label class="row">
					<input type="checkbox" bind:checked={app.ui.show_sidebar} aria-label="show sidebar" />
					show sidebar <code class="ml_md">[backtick `]</code>
				</label>
			</div>
			<!-- TODO idk <div class="my_md">
				<label class="row">
					<input
						type="checkbox"
						bind:checked={app.ui.show_main_dialog}
						aria-label="show main dialog"
					/>
					show main dialog
				</label>
			</div> -->
		</div>
	</section>
	<section class="mb_xl7 display:flex justify-content:center">
		<Footer />
	</section>
</div>

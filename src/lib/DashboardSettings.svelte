<script lang="ts">
	import { icon_settings } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import Settings from './Settings.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import DashboardHeader from './DashboardHeader.svelte';
	import TimeWidget from './TimeWidget.svelte';
	import Footer from './Footer.svelte';

	const app = frontend_context.get();

	// TODO display capabilities (like what APIs are available, including remote server (off when deployed statically), local DB (could be disconnected, websockets?))
	// TODO display database info/explorer
</script>

<div class="p_lg">
	<DashboardHeader>
		{#snippet header()}
			<h1><Svg data={icon_settings} /> system settings</h1>
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

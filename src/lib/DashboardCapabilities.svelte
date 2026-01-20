<script lang="ts">
	import {GLYPH_CAPABILITY} from './glyphs.js';
	import Glyph from './Glyph.svelte';
	import Footer from './Footer.svelte';
	import CapabilitiesView from './CapabilitiesView.svelte';
	import TimeWidget from './TimeWidget.svelte';
	import DashboardHeader from './DashboardHeader.svelte';
	import {frontend_context} from './frontend.svelte.js';

	const app = frontend_context.get();
</script>

<div class="p_lg">
	<DashboardHeader>
		{#snippet header()}
			<h1><Glyph glyph={GLYPH_CAPABILITY} /> system capabilities</h1>
		{/snippet}
		<TimeWidget value={app.time.now} />
	</DashboardHeader>
	<section class="width_atmost_md">
		<p>This page lets you view and control the app's capabilities, its available powers.</p>
		<p>
			Zzz's goal is to connect your intent to the world through machines, so it runs in many
			contexts, and you can do whatever you wish with whatever capabilities are on hand.
		</p>
		<p>
			This is a work in progress. The idea is to put handles on the system for transparency and
			control.
		</p>
	</section>
	<section>
		<CapabilitiesView />
	</section>
	<section class="mb_xl7 display:flex justify-content:center">
		<Footer />
	</section>
</div>

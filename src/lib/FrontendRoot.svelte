<script lang="ts">
	import type {Snippet} from 'svelte';
	import Themed from '@fuzdev/fuz_ui/Themed.svelte';
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import {Frontend, frontend_context} from './frontend.svelte.js';
	import Dashboard from './Dashboard.svelte';
	import MainDialog from './MainDialog.svelte';

	// TODO maybe just make this `Zzz`?

	/*

	Sets `app` in context.

	*/

	const {
		app,
		children,
	}: {
		app: Frontend;
		children: Snippet<[zzz: Frontend]>;
	} = $props();

	frontend_context.set(app);
</script>

<Themed>
	<ContextmenuRoot>
		<MainDialog />
		<!-- TODO user-defined pages should be able to control the full page at runtime -->
		<Dashboard>
			<div class="height:100% overflow:auto">
				{@render children(app)}
			</div>
		</Dashboard>
	</ContextmenuRoot>
</Themed>

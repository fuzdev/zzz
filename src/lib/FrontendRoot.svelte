<script lang="ts">
	import type {Snippet} from 'svelte';
	import ThemeRoot from '@fuzdev/fuz_ui/ThemeRoot.svelte';
	import ContextmenuRoot from '@fuzdev/fuz_ui/ContextmenuRoot.svelte';

	import {Frontend, frontend_context} from './frontend.svelte.js';
	import Dashboard from './Dashboard.svelte';
	import MainDialog from './MainDialog.svelte';
	import DeskMenu from './DeskMenu.svelte';

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

	// svelte-ignore state_referenced_locally
	frontend_context.set(app);
</script>

<ThemeRoot>
	<ContextmenuRoot>
		<MainDialog />
		<DeskMenu />
		<!-- TODO user-defined pages should be able to control the full page at runtime -->
		<Dashboard>
			<div class="height:100% overflow:auto">
				{@render children(app)}
			</div>
		</Dashboard>
	</ContextmenuRoot>
</ThemeRoot>

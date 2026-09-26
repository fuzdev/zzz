<script module lang="ts">
	let projects: Projects;
</script>

<script lang="ts">
	import { projects_context, Projects } from './projects.svelte.ts';
	import { frontend_context } from '$lib/frontend.svelte.ts';
	import { parse_url_param_uuid } from '$lib/nav.ts';
	import { create_detached } from '$lib/reactive_helpers.svelte.ts';

	const { children, params } = $props();

	const app = frontend_context.get();

	// Initialize the Projects instance and set it in context

	// detached — it outlives this layout (see `create_detached`)
	projects ??= create_detached(() => new Projects({ app }));
	projects_context.set(projects);

	// Synchronize URL params to project state
	$effect.pre(() => {
		projects.set_current_project(parse_url_param_uuid(params.project_id));
		projects.set_current_domain(parse_url_param_uuid(params.domain_id));
		projects.set_current_page(parse_url_param_uuid(params.page_id));
	});
</script>

{@render children()}

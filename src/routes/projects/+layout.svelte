<script module lang="ts">
	let projects: Projects;
</script>

<script lang="ts">
	import {projects_context, Projects} from '$routes/projects/projects.svelte.js';
	import {frontend_context} from '$lib/frontend.svelte.js';
	import {parse_url_param_uuid} from '$lib/url_params_helpers.js';

	const {children, params} = $props();

	const app = frontend_context.get();

	// Initialize the Projects instance and set it in context

	projects ??= new Projects({app});
	projects_context.set(projects);

	// Synchronize URL params to project state
	$effect.pre(() => {
		projects.set_current_project(parse_url_param_uuid(params.project_id));
		projects.set_current_domain(parse_url_param_uuid(params.domain_id));
		projects.set_current_page(parse_url_param_uuid(params.page_id));
	});
</script>

{@render children()}

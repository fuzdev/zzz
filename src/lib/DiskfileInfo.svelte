<script lang="ts">
	import { slide } from 'svelte/transition';

	import type { Diskfile } from './diskfile.svelte.ts';
	import { icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
	import DiskfileMetrics from './DiskfileMetrics.svelte';
	import { has_dependencies } from './diskfile_helpers.ts';

	const {
		diskfile,
		editor_state
	}: {
		diskfile: Diskfile;
		editor_state: DiskfileEditorState;
	} = $props();

	const app = frontend_context.get();
</script>

<div class="display:flex flex-direction:column gap_xs width:100%">
	<small class="overflow_wrap_break_all width:100%">
		<Svg data={icon_file} />
		{app.diskfiles.to_relative_path(diskfile.path)}
	</small>

	<small>
		<div>created {diskfile.created_formatted_datetime}</div>
		{#if diskfile.updated_formatted_datetime !== diskfile.created_formatted_datetime}
			<div transition:slide>updated {diskfile.updated_formatted_datetime}</div>
		{/if}
	</small>

	<DiskfileMetrics {editor_state} />

	{#if has_dependencies(diskfile)}
		<small class="font_family_mono" transition:slide>
			<div>{diskfile.dependencies_count} dependencies</div>
			<div>{diskfile.dependents_count} dependents</div>
		</small>
	{/if}

	<small class="font_family_mono">{diskfile.id}</small>
</div>

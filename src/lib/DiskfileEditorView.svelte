<script lang="ts">
	import {untrack} from 'svelte';
	import {slide} from 'svelte/transition';

	import {frontend_context} from './frontend.svelte.js';
	import DiskfileInfo from './DiskfileInfo.svelte';
	import type {Diskfile} from './diskfile.svelte.js';
	import ContentEditor from './ContentEditor.svelte';
	import DiskfileActions from './DiskfileActions.svelte';
	import {DiskfileEditorState} from './diskfile_editor_state.svelte.js';
	import DiskfileHistoryView from './DiskfileHistoryView.svelte';
	import {GLYPH_PLACEHOLDER} from './glyphs.js';
	import DiskfilePartView from './DiskfilePartView.svelte';
	import DiskfileContextmenu from './DiskfileContextmenu.svelte';
	import type {Uuid} from './zod_helpers.js';
	import DiskfileEditorNav from './DiskfileEditorNav.svelte';
	import TutorialForDiskfiles from './TutorialForDiskfiles.svelte';

	const {
		diskfile,
		onmodified,
	}: {
		diskfile: Diskfile;
		onmodified?: (diskfile_id: Uuid) => void;
	} = $props();

	const app = frontend_context.get();

	// TODO @many refactor, maybe move a collection on `app.diskfiles`? one problem is the contextmenu can't access it without hacking something with context
	const editor_state = new DiskfileEditorState({app, diskfile});

	// Reference to the content editor component
	let content_editor: {focus: () => void} | undefined = $state();

	// TODO refactor, try to remove
	$effect(() => {
		if (editor_state.content_was_modified_by_user) {
			onmodified?.(diskfile.id);
		}
	});

	// TODO refactor, try to remove
	$effect.pre(() => {
		// Track diskfile changes explicitly
		const diskfile_id = diskfile.id;
		const diskfile_content = diskfile.content;

		untrack(() => {
			// If the diskfile id changed, this is a navigation to a different file
			if (editor_state.diskfile.id !== diskfile_id) {
				editor_state.update_diskfile(diskfile);
			}
			// Otherwise, if only the content changed, check for disk changes
			else if (diskfile_content !== editor_state.last_seen_disk_content) {
				// This handles the case where the file was updated outside the app
				editor_state.check_disk_changes();
			}
		});
	});
</script>

<DiskfileContextmenu {diskfile}>
	<div class="display:flex height:100%">
		<div class="flex:1 width_atleast_sm height:100% column">
			<ContentEditor
				bind:this={content_editor}
				bind:content={editor_state.current_content}
				token_count={editor_state.current_token_count}
				placeholder={GLYPH_PLACEHOLDER + ' ' + diskfile.path_relative}
				readonly={false}
				attrs={{class: 'height:100% border_radius_0'}}
				onsave={async (value) => {
					await app.diskfiles.update(diskfile.path, value);
				}}
			/>
		</div>

		<div class="width_upto_sm width_atleast_sm py_md">
			<div class="px_md mb_lg">
				<DiskfileActions {diskfile} {editor_state} />
			</div>

			<div class="px_md mb_lg">
				<DiskfileEditorNav {editor_state} />
			</div>

			<div class="px_md mb_lg">
				<DiskfileInfo {diskfile} {editor_state} />
			</div>

			{#if editor_state.has_history}
				<div transition:slide>
					<DiskfileHistoryView
						{editor_state}
						onselectentry={(entry_id) => {
							editor_state.set_content_from_history(entry_id);
							content_editor?.focus();
						}}
					/>
				</div>
			{/if}

			<DiskfilePartView {diskfile} />

			<div class="px_md">
				<TutorialForDiskfiles />
			</div>
		</div>
	</div>
</DiskfileContextmenu>

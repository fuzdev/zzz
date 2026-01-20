<script lang="ts">
	import {untrack} from 'svelte';
	import {slide} from 'svelte/transition';

	import {DiskfilePart} from './part.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import ContentEditor from './ContentEditor.svelte';
	import DiskfileActions from './DiskfileActions.svelte';
	import DiskfileMetrics from './DiskfileMetrics.svelte';
	import {DiskfileEditorState} from './diskfile_editor_state.svelte.js';
	import DiskfileHistoryView from './DiskfileHistoryView.svelte';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import Glyph from './Glyph.svelte';
	import {GLYPH_FILE, GLYPH_PLACEHOLDER} from './glyphs.js';

	const {
		diskfile_part,
		show_actions = true,
	}: {
		diskfile_part: DiskfilePart;
		show_actions?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();

	const {diskfile} = $derived(diskfile_part);

	// Create editor state reference - will be initialized in the effect
	// TODO @many this initialization is awkward, ideally becomes refactored to mostly derived
	// maybe this instance is created once, and it gets a thunk for the diskfile? `DikfileEditorState.of(() => diskfile)`
	let editor_state: DiskfileEditorState | undefined = $state();

	// Keep track of the content editor for focusing
	let content_editor: {focus: () => void} | undefined = $state();

	let show_file_picker = $state(false);

	// TODO probably refactor to avoid the effect, look also at `TODO @many refactor, maybe move a collection on `app.diskfiles`?`
	// Effect for managing editor state lifecycle
	$effect.pre(() => {
		// Track the diskfile from the part
		if (!diskfile) {
			// Clear editor state if no diskfile is available
			editor_state = undefined;
			diskfile_part.link_editor_state(null); // TODO @many this initialization is awkward, ideally becomes refactored to mostly derived
			return;
		}

		// Here's the important part: we use untrack to avoid re-creating
		// the editor state on every render while still updating it when needed
		untrack(() => {
			// Create new editor state if it doesn't exist
			if (!editor_state) {
				editor_state = new DiskfileEditorState({app, diskfile}); // TODO @many refactor, maybe move a collection on `app.diskfiles`?
				diskfile_part.link_editor_state(editor_state); // TODO @many this initialization is awkward, ideally becomes refactored to mostly derived
				return;
			}

			// If diskfile id changed, update the editor state with the new diskfile
			if (editor_state.diskfile.id !== diskfile.id) {
				editor_state.update_diskfile(diskfile);
				diskfile_part.link_editor_state(editor_state); // TODO @many this initialization is awkward, ideally becomes refactored to mostly derived
				return;
			}

			// Check for external disk changes
			if (diskfile.content !== editor_state.last_seen_disk_content) {
				editor_state.check_disk_changes();
			}
		});
	});
</script>

<div class="mb_xs">
	{#if diskfile}
		<small class="mb_xs display:block overflow:hidden white-space:break-spaces">
			{diskfile.path_relative}
		</small>
	{/if}
	<button
		type="button"
		class="plain compact"
		onclick={() => {
			show_file_picker = true;
		}}
	>
		<Glyph glyph={GLYPH_FILE} />
		<small class="ml_xs2">pick file</small>
	</button>
</div>

{#if diskfile && editor_state}
	<div>
		<div class="column">
			<ContentEditor
				bind:this={content_editor}
				bind:content={
					() => editor_state!.current_content,
					(content) => {
						if (editor_state) {
							editor_state.current_content = content;
						}
					}
				}
				token_count={editor_state.current_token_count}
				placeholder={GLYPH_PLACEHOLDER + ' ' + diskfile.path_relative}
				show_stats={false}
				readonly={false}
				onsave={async (value) => {
					await app.diskfiles.update(diskfile.path, value);
				}}
			/>

			{#if show_actions}
				<div class="mt_xs">
					<DiskfileActions {diskfile} {editor_state} />
				</div>
			{/if}
		</div>

		{#if editor_state}
			<div class="my_xs font_size_sm">
				<DiskfileMetrics {editor_state} />
			</div>
		{/if}

		{#if editor_state.has_history}
			<div transition:slide>
				<DiskfileHistoryView
					{editor_state}
					onselectentry={(entry_id) => {
						if (editor_state) {
							editor_state.set_content_from_history(entry_id);
							content_editor?.focus();
						}
					}}
				/>
			</div>
		{/if}
	</div>
{:else}
	<ContentEditor
		content={diskfile_part.content || ''}
		readonly
		placeholder="[no file]"
		attrs={{disabled: true}}
	/>
{/if}

<DiskfilePickerDialog
	selected_ids={diskfile ? [diskfile.id] : []}
	bind:show={show_file_picker}
	onpick={(diskfile) => {
		if (diskfile !== undefined) {
			diskfile_part.path = diskfile ? diskfile.path : diskfile;
		}
	}}
/>

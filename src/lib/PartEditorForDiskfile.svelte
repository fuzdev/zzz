<script lang="ts">
	import { slide } from 'svelte/transition';

	import { DiskfilePart } from './part.svelte.ts';
	import { frontend_context } from './frontend.svelte.ts';
	import ContentEditor from './ContentEditor.svelte';
	import DiskfileActions from './DiskfileActions.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import DiskfileMetrics from './DiskfileMetrics.svelte';
	import DiskfileConflictNotice from './DiskfileConflictNotice.svelte';
	import DiskfileHistoryView from './DiskfileHistoryView.svelte';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import { icon_file } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { format_placeholder } from './helpers.ts';
	import { DISKFILE_CONTENT_NOT_LOADED_MESSAGE } from './diskfile_helpers.ts';

	const {
		diskfile_part,
		show_actions = true
	}: {
		diskfile_part: DiskfilePart;
		show_actions?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();

	const { diskfile } = $derived(diskfile_part);

	// the file's app-level editing state, shared with its other views — disk changes
	// reach it while this is unmounted, and the part reads its content from it
	const editor_state = $derived(diskfile ? app.diskfiles.get_editor_state(diskfile) : undefined);

	// Keep track of the content editor for focusing
	let content_editor: { focus: () => void } | undefined = $state.raw();
	let conflict_notice: { focus: () => boolean } | undefined = $state.raw();

	const save = async (): Promise<void> => {
		if (!editor_state) return;
		// a blocked save points at the conflict notice rather than doing nothing silently
		if (editor_state.has_conflict && conflict_notice?.focus()) return;
		await editor_state.save_changes();
	};

	let show_file_picker = $state.raw(false);
</script>

<div class="mb_xs">
	{#if diskfile}
		<small class="mb_xs display:block overflow:hidden white-space:break-spaces">
			{diskfile.path_relative}
		</small>
	{/if}
	<button
		type="button"
		class="plain sized_sm"
		onclick={() => {
			show_file_picker = true;
		}}
	>
		<Icon data={icon_file} />
		<small class="ml_xs2">pick file</small>
	</button>
</div>

{#if diskfile && editor_state}
	<div>
		{#if !editor_state.content_loaded}
			<p class="mb_xs color_c_60">
				<small>{DISKFILE_CONTENT_NOT_LOADED_MESSAGE} — read-only</small>
			</p>
		{:else if diskfile.deleted_on_disk}
			<p class="mb_xs color_c_60">
				<small>
					deleted on disk — save to recreate it with your edits, or
					<button
						type="button"
						class="inline sized_sm"
						onclick={() => editor_state?.discard_draft()}
						title="discard the unsaved edits and forget the file"
					>
						discard them
					</button>
				</small>
			</p>
		{/if}
		<DiskfileConflictNotice
			bind:this={conflict_notice}
			{editor_state}
			onresolve={() => content_editor?.focus()}
			attrs={{ class: 'mb_xs' }}
		/>
		<div class="column">
			<ContentEditor
				bind:this={content_editor}
				bind:content={
					() => editor_state?.current_content ?? '',
					(content) => {
						if (editor_state) editor_state.current_content = content;
					}
				}
				token_count={editor_state.current_token_count}
				placeholder={editor_state.content_loaded
					? format_placeholder(diskfile.path_relative)
					: '[content not loaded]'}
				show_stats={false}
				readonly={!editor_state.content_loaded}
				onsave={save}
			/>

			{#if show_actions}
				<div class="mt_xs">
					<DiskfileActions {diskfile} {editor_state} readonly={!editor_state.content_loaded} />
				</div>
			{:else if editor_state.save_error !== null}
				<div class="mt_xs" transition:slide>
					<ErrorMessage>
						<small class="font_family_mono">save failed: {editor_state.save_error}</small>
					</ErrorMessage>
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
		attrs={{ disabled: true }}
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

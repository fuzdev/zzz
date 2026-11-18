<script lang="ts">
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import PasteFromClipboard from '@fuzdev/fuz_ui/PasteFromClipboard.svelte';
	import { slide } from 'svelte/transition';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';
	import type { Position } from '@fuzdev/fuz_app/ui/position_helpers.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import ClearRestoreButton from './ClearRestoreButton.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
	import { icon_delete, icon_paste } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';
	import { delete_diskfile } from './diskfile_helpers.ts';

	const {
		diskfile,
		editor_state,
		readonly = false,
		auto_save = false,
		delete_position,
		compare = false
	}: {
		diskfile: Diskfile;
		editor_state: DiskfileEditorState;
		readonly?: boolean | undefined;
		auto_save?: boolean | undefined;
		/**
		 * Where the delete confirmation opens, `ConfirmButton`'s `left` by default - delete can be
		 * the row's first button, so a container that clips at its left edge opens it elsewhere.
		 */
		delete_position?: Position | undefined;
		/**
		 * Whether to offer comparing the file's versions — only where the host
		 * shows the diff (`DiskfileCompareView`) while the file is compared.
		 */
		compare?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();
</script>

<!-- Content modification actions (copy, paste, clear) -->
<div class="flex gap_xs">
	{#if editor_state.content_loaded}
		<!-- what the editor shows, the disk version included -->
		<CopyToClipboard text={editor_state.shown_content} class="plain" />
	{/if}

	{#if !readonly && editor_state.can_edit}
		<PasteFromClipboard
			onclipboardtext={(text) => {
				editor_state.current_content += text;
			}}
			class="plain icon-button font_size_lg"
		>
			<Icon data={icon_paste} />
		</PasteFromClipboard>

		<ClearRestoreButton bind:value={editor_state.current_content} />
	{/if}

	{#if compare && editor_state.content_loaded}
		<button
			type="button"
			class="plain sized_sm selectable"
			class:selected={editor_state.comparing}
			aria-pressed={editor_state.comparing}
			title={editor_state.comparing
				? 'stop comparing, back to the editor'
				: 'show the changes from the file on disk to the version you are editing'}
			onclick={() =>
				app.intents.file_compare_set({
					path: diskfile.path,
					base: editor_state.comparing ? null : 'disk'
				})}
		>
			compare
		</button>
	{/if}

	<!-- Delete button is always available -->
	<ConfirmButton
		onconfirm={() => delete_diskfile(app.diskfiles, diskfile.path)}
		position={delete_position}
		class="plain icon-button"
		title="delete file"
	>
		<Icon data={icon_delete} />
	</ConfirmButton>
</div>

{#if !readonly && !auto_save}
	<div class="mt_xs flex" transition:slide>
		<button
			class="flex:1 palette_f"
			type="button"
			disabled={!editor_state.can_save ||
				editor_state.saving ||
				editor_state.save_pending ||
				editor_state.has_conflict}
			title={editor_state.has_conflict
				? 'changed on disk since you edited it — overwrite or keep the disk version above'
				: undefined}
			onclick={() => editor_state.save_changes()}
		>
			save changes
		</button>
	</div>
{/if}

{#if editor_state.save_error !== null}
	<div class="mt_xs" transition:slide>
		<ErrorMessage>
			<small class="font_family_mono">save failed: {editor_state.save_error}</small>
		</ErrorMessage>
	</div>
{/if}

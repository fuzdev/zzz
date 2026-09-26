<script lang="ts">
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import PasteFromClipboard from '@fuzdev/fuz_ui/PasteFromClipboard.svelte';
	import { slide } from 'svelte/transition';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import type { Diskfile } from './diskfile.svelte.ts';
	import ClearRestoreButton from './ClearRestoreButton.svelte';
	import ErrorMessage from './ErrorMessage.svelte';
	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
	import { icon_delete, icon_paste } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';

	const {
		diskfile,
		editor_state,
		readonly = false,
		auto_save = false
	}: {
		diskfile: Diskfile;
		editor_state: DiskfileEditorState;
		readonly?: boolean | undefined;
		auto_save?: boolean | undefined;
	} = $props();

	const app = frontend_context.get();
</script>

<!-- Content modification actions (copy, paste, clear) -->
<div class="display:flex gap_xs">
	{#if editor_state.content_loaded}
		<CopyToClipboard text={editor_state.current_content} class="plain" />
	{/if}

	{#if !readonly}
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

	<!-- Delete button is always available -->
	<ConfirmButton
		onconfirm={() => app.diskfiles.delete(diskfile.path)}
		class="plain icon-button"
		title="delete file"
	>
		<Icon data={icon_delete} />
	</ConfirmButton>
</div>

{#if !readonly && !auto_save}
	<div class="mt_xs display:flex" transition:slide>
		<button
			class="flex:1 palette_f"
			type="button"
			disabled={!editor_state.can_save || editor_state.saving || editor_state.has_conflict}
			title={editor_state.has_conflict
				? 'changed on disk since you edited it — overwrite or reload above'
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

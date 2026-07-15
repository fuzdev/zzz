<script lang="ts">
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import PasteFromClipboard from '@fuzdev/fuz_ui/PasteFromClipboard.svelte';
	import {slide} from 'svelte/transition';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	import {frontend_context} from './frontend.svelte.ts';
	import type {Diskfile} from './diskfile.svelte.ts';
	import ClearRestoreButton from './ClearRestoreButton.svelte';
	import type {DiskfileEditorState} from './diskfile_editor_state.svelte.ts';
	import {icon_delete, icon_paste} from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	const {
		diskfile,
		editor_state,
		readonly = false,
		auto_save = false,
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
	<CopyToClipboard text={editor_state.current_content} class="plain" />

	{#if !readonly}
		<PasteFromClipboard
			onclipboardtext={(text) => {
				editor_state.current_content += text;
			}}
			class="plain icon-button font_size_lg"
		>
			<Svg data={icon_paste} />
		</PasteFromClipboard>

		<ClearRestoreButton bind:value={editor_state.current_content} />
	{/if}

	<!-- Delete button is always available -->
	<ConfirmButton
		onconfirm={() => app.diskfiles.delete(diskfile.path)}
		class="plain icon-button"
		title="delete file"
	>
		<Svg data={icon_delete} />
	</ConfirmButton>
</div>

{#if !readonly && !auto_save}
	<div class="mt_xs display:flex" transition:slide>
		<button
			class="flex:1 palette_f"
			type="button"
			disabled={!editor_state.has_changes}
			onclick={() => editor_state.save_changes()}
		>
			save changes
		</button>
	</div>
{/if}

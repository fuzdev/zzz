<script lang="ts">
	import CodeDiff from '@fuzdev/fuz_code/CodeDiff.svelte';
	import { flushSync } from 'svelte';
	import { icon_close } from '@fuzdev/fuz_ui/icons.ts';
	import type { SvelteHTMLElements } from 'svelte/elements';

	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
	import type { HistoryEntry } from './diskfile_history.svelte.ts';
	import { lang_for_path } from './path_lang.ts';
	import { DISKFILE_COMPARE_FOLD_MAX_LENGTH } from './diskfile_compare.ts';
	import { format_time } from './time_helpers.ts';
	import Icon from './Icon.svelte';

	const {
		editor_state,
		onclose,
		attrs
	}: {
		/** The file compared — its `compare_base_content` to its `current_content`. */
		editor_state: DiskfileEditorState;
		/** Called after the user stops comparing here, e.g. to refocus the editor. */
		onclose?: (() => void) | undefined;
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	const app = frontend_context.get();

	let base_select: HTMLSelectElement | undefined = $state.raw();

	/** Moves focus to the base picker — where a settled conflict leaves the user while comparing. */
	export const focus = (): void => {
		base_select?.focus();
	};

	const path = $derived(editor_state.path);
	const lang = $derived(lang_for_path(path));
	const base_raw = $derived(editor_state.compare_base_content ?? '');
	const content = $derived(editor_state.current_content);
	// the editor reads CRLF and CR as LF, so a base with them would show every line changed
	// against an edit: the diff compares it as LF, as the textarea does, and a note says why
	const cr_converted = $derived(base_raw.includes('\r') && !content.includes('\r'));
	const base_content = $derived(cr_converted ? base_raw.replace(/\r\n?/g, '\n') : base_raw);
	// the disk's line endings are what a save changes - a base's alone are only compared
	const save_converts = $derived(
		cr_converted && (editor_state.original_content?.includes('\r') ?? false)
	);
	const selected_base = $derived(editor_state.compare_base_entry?.id ?? 'disk');
	const split = $derived(app.ui.diff_split);
	// a large file's unchanged regions are left out, not folded, and its lines aren't
	// highlighted, which halves the HTML a rewrite makes (see the constant)
	const large = $derived(
		Math.max(base_content.length, content.length) > DISKFILE_COMPARE_FOLD_MAX_LENGTH
	);

	const to_entry_label = (entry: HistoryEntry): string => {
		// the length tells apart entries made the same second, as the history list shows it
		const time = `${format_time(new Date(entry.created))}, ${entry.content.length} chars`;
		if (entry.id === editor_state.unsaved_edit_entry_id) return `${time} — unsaved`;
		if (entry.is_discarded_edit) return `${time} — discarded`;
		if (entry.is_disk_change) return `${time} — from disk`;
		return time;
	};
</script>

<div {...attrs} class="column {attrs?.class ?? ''}">
	<div class="row_wrap gap_xs px_md py_xs">
		<label class="row gap_xs mb_0">
			<small class="white-space:nowrap">changes from</small>
			<select
				bind:this={base_select}
				class="sized_sm width:auto mb_0"
				value={selected_base}
				onchange={(event) => {
					const { value } = event.currentTarget;
					// an entry gone from the history since the options rendered falls back to the disk
					const entry = editor_state.content_history.find((e) => e.id === value);
					app.intents.file_compare_set({ path, base: entry?.id ?? 'disk' });
				}}
			>
				<option value="disk">
					{editor_state.diskfile.deleted_on_disk
						? 'the last version seen on disk'
						: 'the version on disk'}
				</option>
				{#each editor_state.content_history as entry (entry.id)}
					<option value={entry.id}>{to_entry_label(entry)}</option>
				{/each}
			</select>
			<small class="white-space:nowrap">to the version you're editing</small>
		</label>
		<div class="flex:1"></div>
		<button
			type="button"
			class="plain sized_sm selectable"
			class:selected={!split}
			aria-pressed={!split}
			title="show the changes in one column"
			onclick={() => app.intents.diff_split_toggle({ split: false })}
		>
			unified
		</button>
		<button
			type="button"
			class="plain sized_sm selectable"
			class:selected={split}
			aria-pressed={split}
			title="show the two versions side by side"
			onclick={() => app.intents.diff_split_toggle({ split: true })}
		>
			split
		</button>
		<button
			type="button"
			class="plain sized_sm"
			title="stop comparing, back to the editor"
			onclick={() => {
				app.intents.file_compare_set({ path, base: null });
				// the editor shows again before `onclose` focuses it
				flushSync();
				onclose?.();
			}}
		>
			<Icon data={icon_close} /> <span class="ml_xs">close</span>
		</button>
	</div>
	<div class="flex:1 min-height:0 overflow:auto px_md pb_md">
		{#if cr_converted}
			<p class="color_c_60 font_size_sm">
				{save_converts
					? "compared as LF — saving converts this file's CRLF or CR line endings to LF"
					: "this version's CRLF or CR line endings are compared as LF"}
			</p>
		{/if}
		{#if base_raw === content}
			<p class="color_c_60">no changes — the two versions are the same</p>
		{:else if base_content === content}
			<p class="color_c_60">only the line endings differ</p>
		{:else}
			{#if large}
				<p class="color_c_60 font_size_sm">
					a file this large shows only its changes and the lines around them, unhighlighted
				</p>
			{/if}
			<!-- markdown is prose, whose long lines read better wrapped -->
			<CodeDiff
				a={base_content}
				b={content}
				lang={large ? null : lang}
				{split}
				wrap={lang === 'md'}
				elide={large ? 'omit' : 'details'}
				nomargin
			/>
		{/if}
	</div>
</div>

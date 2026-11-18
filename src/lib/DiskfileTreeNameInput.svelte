<script lang="ts">
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { swallow } from '@fuzdev/fuz_util/dom.ts';
	import { icon_directory, icon_file } from '@fuzdev/fuz_ui/icons.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import type { DiskfileTreeNamingRow } from './diskfile_tree_state.svelte.ts';
	import Icon from './Icon.svelte';

	/**
	 * The file tree's inline input (`DiskfileTreeState.naming`), a row of the
	 * tree like the others: naming a new file or folder as its folder's first
	 * child, or renaming a file in place of its row, its current name filled
	 * in with the part before the extension selected. Enter commits
	 * (`DiskfileTreeState.commit_naming`), Escape cancels, and either returns
	 * focus to the tree; the tree leaves every key typed here to the input. A
	 * refused name shows its reason under the row, which keeps the tree's one
	 * row height: politely as it's typed (a trailing `/` on a new file's name
	 * waits for Enter, since typing `sub/x.md` passes through it), at once for
	 * a refused commit.
	 *
	 * Leaving the input, like VS Code, commits a valid name and drops a blank
	 * or refused one (refused by the name's rules or, already, by the
	 * backend) — but not when the whole window lost focus, nor when the row
	 * scrolled out of the tree's window: the name is kept on the state, and the
	 * input takes focus again when it remounts with focus lost. Remounting with
	 * focus gone elsewhere — the user left it while it was away, a blur that
	 * never fired — it's dropped, valid name or not: committing on a scroll
	 * would surprise.
	 *
	 * @module
	 */

	const {
		row,
		id,
		index
	}: {
		row: DiskfileTreeNamingRow;
		/** The element id the tree's `aria-activedescendant` names. */
		id: string;
		/** The row's position in `DiskfileTreeState.rows`. */
		index: number;
	} = $props();

	const { diskfiles } = frontend_context.get();
	const { tree } = diskfiles.editor;

	const error_id = $props.id();

	const naming = $derived(tree.naming);

	// as typed: a new file's name ending in `/` is a file name on its way, not yet worth a word
	const name_error = $derived.by(() => {
		if (!naming?.name) return null;
		if (naming.kind === 'create' && naming.create_kind === 'file' && naming.name.endsWith('/')) {
			return null;
		}
		const parsed = naming.parse();
		return parsed.ok ? null : parsed.message;
	});
	// a refused commit's reason, said at once (`role="alert"`); one as typed, politely
	const commit_error = $derived(naming?.error ?? null);
	const error = $derived(commit_error ?? name_error);

	const to_tree_el = (input: HTMLElement): HTMLElement | null =>
		input.closest<HTMLElement>('[role="tree"]');

	// back to the tree once the input closes — unless the user has moved focus on meanwhile
	const return_focus = (tree_el: HTMLElement | null, input: HTMLInputElement): void => {
		const active = document.activeElement;
		if (!active || active === document.body || active === input) tree_el?.focus();
	};

	const submit = async (input: HTMLInputElement): Promise<void> => {
		const started = tree.naming;
		if (!started) return;
		// before the row unmounts, which detaches the input from the tree
		const tree_el = to_tree_el(input);
		await tree.commit_naming();
		// still open: the name was refused, shown here, and the input keeps focus
		if (tree.naming === started) return;
		return_focus(tree_el, input);
	};

	const onkeydown = (e: KeyboardEvent & { currentTarget: HTMLInputElement }): void => {
		if (e.key === 'Enter') {
			swallow(e);
			void submit(e.currentTarget);
		} else if (e.key === 'Escape') {
			swallow(e);
			if (!tree.naming) return;
			// ended first, so the blur that moving focus causes finds nothing to act on
			tree.cancel_naming();
			return_focus(to_tree_el(e.currentTarget), e.currentTarget);
		}
	};

	const onblur = (e: FocusEvent & { currentTarget: HTMLInputElement }): void => {
		const input = e.currentTarget;
		const started = tree.naming;
		// a tick later, to see where focus went and whether the row is still mounted
		setTimeout(() => {
			if (!started || started !== tree.naming || started.pending) return;
			if (!input.isConnected || document.activeElement === input || !document.hasFocus()) return;
			// a name the backend refused isn't sent again on every blur: leaving drops it
			if (!started.error && started.name && started.parse().ok) {
				void tree.commit_naming();
			} else {
				tree.cancel_naming();
			}
		});
	};

	// focus at the start, and again when it remounts with focus lost (scrolled out and back); a
	// remount with focus gone elsewhere means the user left it while it was away — a blur that
	// never fired — so it's dropped, not committed, since a commit shouldn't come from a scroll;
	// `mounted` tells `commit_naming` whether this input is there to show a failure
	const focus_on_start: Attachment<HTMLInputElement> = (input) => {
		const started = untrack(() => tree.naming);
		if (!started) return;
		untrack(() => {
			const focus_lost = !document.activeElement || document.activeElement === document.body;
			if (!started.focus_pending && !focus_lost) {
				tree.cancel_naming();
				return;
			}
			const first = started.focus_pending;
			started.focus_pending = false;
			started.mounted = true;
			input.focus();
			// a rename starts with the name before its extension selected, as in VS Code — a
			// dotfile's whole name, having none; a remount keeps the browser's own selection
			if (first && started.kind === 'rename') {
				const dot = started.name.lastIndexOf('.');
				input.setSelectionRange(0, dot > 0 ? dot : started.name.length);
			}
		});
		return () => {
			started.mounted = false;
		};
	};

	const label = $derived(
		row.kind === 'create'
			? `new ${row.create_kind} name in ${row.path}`
			: `new name for ${row.label}`
	);
</script>

<li
	role="treeitem"
	{id}
	data-index={index}
	aria-level={row.depth + 1}
	aria-setsize={row.kind === 'rename' ? row.setsize : undefined}
	aria-posinset={row.kind === 'rename' ? row.posinset : undefined}
	aria-selected="false"
	class="name-item"
	style:--depth={row.depth}
>
	<!-- the same box as `DiskfileTreeitem`'s rows, so the tree's rows keep one height -->
	<div class="name-row menuitem sized_sm">
		<small class="row min-width:0 flex:1">
			<span class="chevron-space"></span>
			<Icon
				data={row.kind === 'create' && row.create_kind === 'folder' ? icon_directory : icon_file}
			/>
			<!-- a fresh input per create or rename, though a second in the same place keeps this row:
			no undo history or selection carried over, and `focus_on_start` keeps meaning "on mount" -->
			{#key naming}
				{#if naming}
					<input
						type="text"
						class="name-input ml_xs"
						aria-label={label}
						aria-invalid={!!error}
						aria-describedby={error ? error_id : undefined}
						aria-busy={naming.pending}
						readonly={naming.pending}
						autocomplete="off"
						spellcheck="false"
						value={naming.name}
						oninput={(e) => {
							naming.name = e.currentTarget.value;
							naming.error = null;
						}}
						{onkeydown}
						{onblur}
						{@attach focus_on_start}
					/>
				{/if}
			{/key}
		</small>
	</div>
	<!-- the polite region is always here and never hidden, so it's in the accessibility tree before
	what it announces; empty and borderless, it shows nothing -->
	<div id={error_id} aria-live="polite" class="name-error">
		{#if commit_error}
			<small role="alert" class="name-error-box shade_00 negative_50 px_xs border_radius_xs">
				{commit_error}
			</small>
		{:else if name_error}
			<small class="name-error-box shade_00 negative_50 px_xs border_radius_xs">
				{name_error}
			</small>
		{/if}
	</div>
</li>

<style>
	.name-item {
		position: relative;
	}
	/* `DiskfileTreeitem`'s indent — a create's row is one level in from its folder */
	.name-row {
		padding-left: calc(var(--space_xs2) + var(--depth, 0) * var(--space_md));
	}
	.chevron-space {
		flex-shrink: 0;
		width: 1em;
	}
	/* a line tall, so the row is as tall as a name's */
	.name-input {
		flex: 1;
		min-width: 0;
		height: 1lh;
		min-height: 0;
		padding-block: 0;
		font-size: inherit;
		line-height: inherit;
	}
	/* over the rows below, not between them — windowing needs every row the same height —
	and a note, not a control: clicks reach the rows beneath */
	.name-error {
		position: absolute;
		top: 100%;
		left: calc(var(--space_xs2) + (var(--depth, 0) + 1) * var(--space_md));
		right: 0;
		z-index: 1;
		pointer-events: none;
	}
	.name-error-box {
		display: block;
		border: var(--border_width) solid currentColor;
	}
</style>

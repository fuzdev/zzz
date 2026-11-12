<script lang="ts">
	// A terminal view over libghostty-vt: it instantiates the compiled module it's
	// given, owns that instance's terminal and render-state reader, and draws the
	// screen as DOM text, and sends the keys typed into it — and what its host
	// pastes (`paste`) — to `ondata`. See
	// `FuzTerminalState` for the frame loop and the keys, and `FuzTerminalOptions`
	// for the props.
	//
	// The host gives it a sized box: it fills its container (`width` and `height`
	// 100%), so the container needs a definite size — an explicit height, or a
	// flex or grid item that's stretched (with `min-height: 0` in a flex column).
	// Its own content never sizes it. A box with no size is unmeasurable, and the
	// terminal keeps its size until the box has one; a view whose first frame
	// finds no size warns once in the console.
	//
	// While it takes keys (ready, `accepts_input` on) its root carries
	// `data-fuz-terminal-keys` (`FUZ_TERMINAL_KEYS_ATTRIBUTE`): a page's global
	// shortcuts check `is_fuz_terminal_key_target` and leave those keys alone.
	import { onMount } from 'svelte';

	import { fuz_terminal_deps_context } from './fuz_terminal_deps.ts';
	import { split_fuz_terminal_runs, type FuzTerminalSize } from './fuz_terminal_layout.ts';
	import {
		FuzTerminalState,
		type FuzTerminalOptions,
		type FuzTerminalPasteOptions,
		type FuzTerminalPasteResult,
		type FuzTerminalStatus,
		type FuzTerminalWriteOptions
	} from './fuz_terminal_state.svelte.ts';
	import type { GhosttyRenderRow } from './ghostty_render_frame.ts';

	const {
		label = 'terminal',
		...options
	}: FuzTerminalOptions & {
		/** The terminal's accessible name. */
		label?: string;
	} = $props();

	// the options are read lazily: `module` and `scrollback_max_bytes` once, when
	// the view starts; the callbacks whenever they're called
	const view_state = new FuzTerminalState(() => options, fuz_terminal_deps_context.get());

	let root_el: HTMLDivElement | undefined = $state.raw();
	let probe_el: HTMLSpanElement | undefined = $state.raw();

	onMount(() => {
		view_state.attach(root_el!, probe_el!);
		return () => view_state.destroy();
	});

	/**
	 * Feed program output; `{replay: true}` for earlier output replayed, which
	 * answers nothing. See `FuzTerminalState.write`.
	 */
	export const write = (data: Uint8Array | string, write_options?: FuzTerminalWriteOptions): void =>
		view_state.write(data, write_options);

	/**
	 * Paste text as the person typing it: encoded under the terminal's modes
	 * and sent to `ondata`, whole or not at all — refused while the view takes
	 * no input, past `max_length`, and for text that could inject commands
	 * unless `allow_unsafe` names the hazard the person confirmed. See
	 * `FuzTerminalState.paste`.
	 */
	export const paste = (
		text: string,
		paste_options?: FuzTerminalPasteOptions
	): FuzTerminalPasteResult => view_state.paste(text, paste_options);

	/** The screen as plain text, for a copy-all; see `FuzTerminalState.get_text`. */
	export const get_text = (): string => view_state.get_text();

	/** Move focus to the terminal. */
	export const focus = (): void => root_el?.focus();

	/** Where the view is: loading, ready, failed, or poisoned. */
	export const get_status = (): FuzTerminalStatus => view_state.status;

	/** The terminal's size in cells, or `null` until it's created. */
	export const get_size = (): FuzTerminalSize | null => view_state.size;

	const onfocusout = (event: FocusEvent): void => {
		const next = event.relatedTarget;
		view_state.focused = next instanceof Node && root_el?.contains(next) === true;
		if (!view_state.focused) view_state.forget_held_keys();
	};

	// a key the terminal sent to the program is the program's alone: no
	// browser default (Tab moving focus, a shortcut) runs for it
	const onkeydown = (event: KeyboardEvent): void => {
		if (view_state.handle_key(event, 'keydown')) event.preventDefault();
	};

	const onkeyup = (event: KeyboardEvent): void => {
		if (view_state.handle_key(event, 'keyup')) event.preventDefault();
	};
</script>

<!-- keys typed while the root has focus go to the program, and a host's `paste`;
TODO: a hidden textarea inside it for IME composition and the paste events -->
<!-- TODO: a deliberate screen-reader mode, which settles the root's role (a
`group` keeps the rows browsable as text; `application` would hand a screen
reader's keys to the program); for now the rows are plain text in the tree, and
nothing is a live region, so a repaint announces nothing -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={root_el}
	class="fuz-terminal"
	role="group"
	aria-roledescription="terminal"
	aria-label={label}
	data-fuz-terminal-keys={view_state.takes_keys ? '' : undefined}
	tabindex="0"
	style={view_state.theme_css}
	style:--fuz_terminal_cursor={view_state.cursor_color}
	style:--fuz_terminal_cell_width={view_state.cell_width === null
		? null
		: `${view_state.cell_width}px`}
	style:--fuz_terminal_cell_height={view_state.cell_height === null
		? null
		: `${view_state.cell_height}px`}
	onfocusin={() => (view_state.focused = true)}
	{onfocusout}
	{onkeydown}
	{onkeyup}
>
	<!-- a layer over the root's box: the rows never size the box they're measured from -->
	<div class="fuz-terminal-screen">
		{#each view_state.rows as row (row.id)}
			{@render terminal_row(row)}
		{/each}
		{#if view_state.cursor_box}
			{@const box = view_state.cursor_box}
			<div
				class={[
					'cursor',
					`cursor-${box.shape.replace('_', '-')}`,
					box.blinking && 'cursor-blinking'
				]}
				style:--cursor_x={box.x}
				style:--cursor_y={box.y}
				style:--cursor_width={box.width}
				aria-hidden="true"
			>
				{#if box.shape === 'block'}{box.text}{/if}
			</div>
		{/if}
	</div>
	<span bind:this={probe_el} class="probe" aria-hidden="true">0000000000</span>
	{#if view_state.status.kind === 'failed'}
		<p class="message" role="alert">the terminal failed: {view_state.status.message}</p>
	{:else if view_state.status.kind === 'poisoned'}
		<p class="message" role="alert">
			the terminal stopped after an internal error and must be reopened: {view_state.status.message}
		</p>
	{:else if view_state.notice !== null}
		<p class="message" role="status">{view_state.notice}</p>
	{/if}
</div>

<!-- an unchanged row is the same object in the next frame, so its block doesn't rerun -->
{#snippet terminal_row(row: GhosttyRenderRow)}
	<div class="fuz-terminal-row">
		{#each split_fuz_terminal_runs(row.runs) as run (run.x)}
			<span
				class={[
					'run',
					run.cluster && 'run-cluster',
					run.style.blink && 'run-blink',
					run.hyperlink && 'run-link'
				]}
				style={view_state.style_css(run.style)}
				style:--run_x={run.x}
				style:--run_width={run.width}
			>
				{run.text}
			</span>
		{/each}
	</div>
{/snippet}

<style>
	/* the theme: hosts override the `--fuz_terminal_*` inputs on an ancestor */
	.fuz-terminal {
		--fuz_terminal_theme_fg: var(--fuz_terminal_foreground, var(--text_color));
		--fuz_terminal_theme_bg: var(--fuz_terminal_background, var(--shade_00));
		--fuz_terminal_fg: var(--fuz_terminal_theme_fg);
		--fuz_terminal_bg: var(--fuz_terminal_theme_bg);
		/* the text color in effect, a program's own included */
		--fuz_terminal_cursor: var(--fuz_terminal_cursor_color, var(--fuz_terminal_fg));
		/* black is dark and white light in either scheme, as programs expect
		(black text on a green status bar, white on blue); fuz_css's gray scales
		follow the scheme (its only fixed opaque neutrals are pure black and
		white), so these are literal grays */
		--fuz_terminal_palette_0: var(--fuz_terminal_color_0, #1c1c1c);
		--fuz_terminal_palette_1: var(--fuz_terminal_color_1, var(--palette_c_50));
		--fuz_terminal_palette_2: var(--fuz_terminal_color_2, var(--palette_b_50));
		--fuz_terminal_palette_3: var(--fuz_terminal_color_3, var(--palette_e_50));
		--fuz_terminal_palette_4: var(--fuz_terminal_color_4, var(--palette_a_50));
		--fuz_terminal_palette_5: var(--fuz_terminal_color_5, var(--palette_d_50));
		--fuz_terminal_palette_6: var(--fuz_terminal_color_6, var(--palette_i_50));
		--fuz_terminal_palette_7: var(--fuz_terminal_color_7, #c8c8c8);
		--fuz_terminal_palette_8: var(--fuz_terminal_color_8, #808080);
		/* the bright hues are the higher-contrast stops, in either scheme */
		--fuz_terminal_palette_9: var(--fuz_terminal_color_9, var(--palette_c_70));
		--fuz_terminal_palette_10: var(--fuz_terminal_color_10, var(--palette_b_70));
		--fuz_terminal_palette_11: var(--fuz_terminal_color_11, var(--palette_e_70));
		--fuz_terminal_palette_12: var(--fuz_terminal_color_12, var(--palette_a_70));
		--fuz_terminal_palette_13: var(--fuz_terminal_color_13, var(--palette_d_70));
		--fuz_terminal_palette_14: var(--fuz_terminal_color_14, var(--palette_i_70));
		--fuz_terminal_palette_15: var(--fuz_terminal_color_15, #f8f8f8);
		/* one cell for every box, the measured one (set inline) once there is one */
		--fuz_terminal_line: calc(var(--fuz_terminal_line_height, 1.2) * 1em);
		--fuz_terminal_col: var(--fuz_terminal_cell_width, 1ch);
		--fuz_terminal_row: var(--fuz_terminal_cell_height, var(--fuz_terminal_line));

		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		color: var(--fuz_terminal_fg);
		background-color: var(--fuz_terminal_bg);
		font-family: var(--fuz_terminal_font_family, var(--font_family_mono));
		font-size: var(--fuz_terminal_font_size, var(--font_size_sm));
		line-height: var(--fuz_terminal_row);
		/* what a host's text styles would pass down that moves the runs off
		their columns or changes their glyphs: alignment and indent move a row's
		runs, `rtl` starts them from the right and a vertical writing mode turns
		them, a transform changes the text (and its copy), spacing, kerning,
		ligatures, and font features move glyphs off their cells, and a weight or
		style would make every run look bold or italic, which only a program's
		style may (`font-variant: none` turns off ligatures and resets the rest of
		the variants), and a `user-select: none` would make the rows unselectable,
		so no selection could copy them */
		direction: ltr;
		writing-mode: horizontal-tb;
		text-align: left;
		text-align-last: auto;
		text-indent: 0;
		text-transform: none;
		letter-spacing: normal;
		word-spacing: normal;
		font-weight: normal;
		font-style: normal;
		font-variant: none;
		font-feature-settings: normal;
		font-variation-settings: normal;
		font-kerning: none;
		user-select: text;
	}
	/* inside the root, so a host's `overflow: hidden` can't clip the ring */
	.fuz-terminal:focus-visible {
		outline-offset: -2px;
	}
	/* the screen and row classes are prefixed, never a utility's name, and set
	their own `display`, so no global class lays them out: a grid screen would
	spread the rows over its leftover height, drifting them from the cursor,
	and a flex row would split its runs into lines. In block flow row `y`
	starts at `y` rows, where the cursor is placed */
	.fuz-terminal-screen {
		display: block;
		position: absolute;
		inset: 0;
		overflow: hidden;
	}
	/* a block per row, so a selection copies a row as one line */
	.fuz-terminal-row {
		display: block;
		height: var(--fuz_terminal_row);
		line-height: var(--fuz_terminal_row);
		white-space: pre;
		overflow: hidden;
	}
	/* inline-level boxes, so the row's runs copy as one line. Each sits at its own
	column, `left` of `x × col` (one rounding, the cursor's own), never after the
	runs before it: their widths would each be rounded to the engine's layout
	unit, drifting a run of a style-dense row (`ls --color`, htop) off its
	column, and the cursor off the text. So a run takes no room in the line, its
	`margin-right` cancelling its `width` exactly (the same length negated), and
	is offset from the row's start; its box overlaps the next by a sliver, which
	the next paints over, so the two roundings that end one run and start the
	next can't leave a hairline of the row's background between them */
	.run {
		--run_box: calc(var(--run_width) * var(--fuz_terminal_col) + 1px / 16);
		display: inline-block;
		position: relative;
		left: calc(var(--run_x) * var(--fuz_terminal_col));
		vertical-align: top;
		width: var(--run_box);
		margin-right: calc(-1 * var(--run_box));
		height: var(--fuz_terminal_row);
	}
	.run-cluster {
		text-align: center;
	}
	.run-link:hover {
		text-decoration-line: underline;
		text-decoration-style: dotted;
	}
	.run-blink {
		animation: fuz-terminal-blink-text 1s step-end infinite;
	}
	.cursor {
		position: absolute;
		left: calc(var(--cursor_x) * var(--fuz_terminal_col));
		top: calc(var(--cursor_y) * var(--fuz_terminal_row));
		width: calc(var(--cursor_width) * var(--fuz_terminal_col));
		height: var(--fuz_terminal_row);
		white-space: pre;
		text-align: center;
		pointer-events: none;
		user-select: none;
	}
	.cursor-block {
		color: var(--fuz_terminal_bg);
		background-color: var(--fuz_terminal_cursor);
	}
	.cursor-block-hollow {
		box-shadow: inset 0 0 0 var(--border_width_1) var(--fuz_terminal_cursor);
	}
	.cursor-bar {
		box-shadow: inset var(--border_width_2) 0 0 0 var(--fuz_terminal_cursor);
	}
	.cursor-underline {
		box-shadow: inset 0 calc(-1 * var(--border_width_2)) 0 0 var(--fuz_terminal_cursor);
	}
	.cursor-blinking {
		animation: fuz-terminal-blink 1s step-end infinite;
	}
	/* measures the font's own cell: never the measured custom properties */
	.probe {
		position: absolute;
		top: 0;
		left: 0;
		line-height: var(--fuz_terminal_line);
		visibility: hidden;
		white-space: pre;
		pointer-events: none;
		/* never part of a selection a copy takes */
		user-select: none;
	}
	.message {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		margin: 0;
		padding: var(--space_xs) var(--space_sm);
		font-family: var(--font_family);
		line-height: normal;
		color: var(--text_color);
		background-color: var(--shade_10);
		white-space: normal;
	}
	@keyframes fuz-terminal-blink {
		50% {
			opacity: 0;
		}
	}
	/* the text only: the background stays */
	@keyframes fuz-terminal-blink-text {
		50% {
			color: transparent;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.run-blink,
		.cursor-blinking {
			animation: none;
		}
	}
</style>

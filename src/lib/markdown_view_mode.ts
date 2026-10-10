/**
 * The layouts of the markdown file view (`DiskfileMarkdownView`).
 *
 * @module
 */

/**
 * `split` shows the source beside its preview, `preview` the rendered
 * markdown alone, and `source` the source alone.
 */
export type MarkdownViewMode = 'split' | 'preview' | 'source';

/** The markdown view's modes, in the order the UI offers them. */
export const MARKDOWN_VIEW_MODES: ReadonlyArray<MarkdownViewMode> = ['split', 'preview', 'source'];

/** What each mode is called in the UI. */
export const MARKDOWN_VIEW_MODE_LABELS: Readonly<Record<MarkdownViewMode, string>> = {
	split: 'split view',
	preview: 'preview',
	source: 'source'
};

/**
 * The mode a file opens in until one is chosen: `preview` where its content
 * is read-only (not loaded), else `split`.
 *
 * @param content_loaded - whether the file's content was loaded, so it can be edited
 */
export const to_default_markdown_view_mode = (content_loaded: boolean): MarkdownViewMode =>
	content_loaded ? 'split' : 'preview';

/**
 * Each mode's keyboard shortcut, Ctrl+Shift with its position in
 * `MARKDOWN_VIEW_MODES` — as shown in the UI.
 */
export const MARKDOWN_VIEW_MODE_SHORTCUTS: Readonly<Record<MarkdownViewMode, string>> = {
	split: 'Ctrl+Shift+1',
	preview: 'Ctrl+Shift+2',
	source: 'Ctrl+Shift+3'
};

/**
 * The mode a keydown switches the markdown view to, or `null` when it isn't
 * one of `MARKDOWN_VIEW_MODE_SHORTCUTS`. Matches the physical digit key
 * (`event.code`), since Shift turns the digit into a layout's symbol, and
 * takes Ctrl on every platform — Cmd+Shift+3 is a macOS screenshot. Ctrl+Shift
 * types no character, so taking it from a textarea loses no input.
 *
 * @param event - the keydown event
 */
export const to_markdown_view_mode_for_shortcut = (
	event: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>
): MarkdownViewMode | null => {
	if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null;
	switch (event.code) {
		case 'Digit1':
		case 'Numpad1':
			return 'split';
		case 'Digit2':
		case 'Numpad2':
			return 'preview';
		case 'Digit3':
		case 'Numpad3':
			return 'source';
		default:
			return null;
	}
};

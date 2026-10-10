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

/**
 * Escape-sequence constants the fuz_terminal tests write to a terminal or
 * expect back from it.
 *
 * @module
 */

export const ESC = '\x1b';
export const BEL = '\x07';
/** String terminator (`ESC \`). */
export const ST = `${ESC}\\`;
/** Control sequence introducer. */
export const CSI = `${ESC}[`;
/** Single shift 3, the prefix of the application-mode keys. */
export const SS3 = `${ESC}O`;
/** A cursor position report request (DSR 6), which a live terminal answers with `ESC [ row ; col R`. */
export const CPR = `${ESC}[6n`;

/**
 * Comparing a file's content: what the diff (`DiskfileCompareView`) is from.
 *
 * @module
 */

import { literal, union, type Infer } from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

/**
 * What a file's content is compared against: `'disk'`, the version on disk,
 * or a history entry's id (`DiskfileEditorState.content_history`).
 */
export const DiskfileCompareBase = union([literal('disk'), Uuid]);
export type DiskfileCompareBase = Infer<typeof DiskfileCompareBase>;

/**
 * The text length (UTF-16 code units, either side's) above which a diff
 * omits its unchanged regions instead of folding them into `<details>`:
 * folded, every unchanged line is still rendered, so a large file with a
 * small change makes tens of MB of HTML (a 4 MiB file about 34 MB unified,
 * twice that split); omitted, the HTML grows with the change alone. Above
 * it the lines aren't highlighted either, which halves what a rewrite of
 * the whole file makes — still tens of MB for a large one.
 */
export const DISKFILE_COMPARE_FOLD_MAX_LENGTH = 256 * 1024;

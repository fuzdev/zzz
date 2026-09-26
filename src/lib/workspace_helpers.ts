import type { Result } from '@fuzdev/fuz_util/result.ts';

import { DiskfileDirectoryPath } from './diskfile_types.ts';

/**
 * `data.reason` of the `invalid_params` error `workspace_close` returns for a
 * path that isn't an open workspace — e.g. one a daemon restart forgot.
 */
export const ERROR_WORKSPACE_NOT_OPEN = 'workspace_not_open';

/**
 * What to tell the user about a workspace whose `watch_status` is
 * `degraded`: some of its directories have no file watch, so the daemon
 * rescans them every few seconds instead.
 */
export const WORKSPACE_DEGRADED_NOTICE =
	"Not every directory has a file watch (likely the system's watch limit) — changes in some show up after a few seconds.";

/**
 * Parse user input (the open-workspace form or the `?workspace=` URL param)
 * into a workspace directory path, without throwing.
 *
 * The input is trimmed and must be absolute. A leading `~` is rejected rather
 * than expanded — the frontend can't know the daemon's home directory. The
 * result is not canonical (`/a/./b/` and symlinked paths pass through as
 * given); the daemon canonicalizes on `workspace_open`, so callers should
 * activate by the path in its output, not by this one.
 *
 * @param raw - the path as typed or passed in the URL
 * @returns the path with a trailing slash, or a user-facing error message
 */
export const parse_workspace_path = (
	raw: string
): Result<{ path: DiskfileDirectoryPath }, { message: string }> => {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, message: 'path is required' };
	if (trimmed.startsWith('~')) {
		return {
			ok: false,
			message: `path must be absolute — "~" is not expanded, use the full path: ${trimmed}`
		};
	}
	const parsed = DiskfileDirectoryPath.safeParse(trimmed);
	if (!parsed.success) {
		return {
			ok: false,
			message: `${parsed.error.issues[0]?.message ?? 'invalid path'}: ${trimmed}`
		};
	}
	return { ok: true, path: parsed.data };
};

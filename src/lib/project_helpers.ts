import { parse } from '@fuzdev/fuz_schema/schema.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import { DiskfilePath } from './diskfile_types.ts';

/**
 * `data.reason` of the `invalid_params` error `project_close` returns for a
 * root that isn't an open project — e.g. one a daemon restart forgot.
 */
export const ERROR_PROJECT_NOT_OPEN = 'project_not_open';

/**
 * `data.reason` of the `invalid_params` error `repo_files` returns for a
 * directory the project doesn't focus — one unfocused since a client learned
 * of its focus, as distinct from an empty repo.
 */
export const ERROR_REPO_NOT_FOCUSED = 'repo_not_focused';

/**
 * What to tell the user about a project whose `watch_status` is
 * `degraded`: some of its directories have no file watch, so the daemon
 * rescans them every few seconds instead.
 */
export const PROJECT_DEGRADED_NOTICE =
	"Not every directory has a file watch (likely the system's watch limit) — changes in some show up after a few seconds.";

/**
 * Parse user input (the open-project form or the `?project=` URL param) into
 * a path to open, without throwing — a directory or a file, which opens the
 * project holding it.
 *
 * The input is trimmed and must be absolute. A leading `~` is rejected rather
 * than expanded — the frontend can't know the daemon's home directory. The
 * result is not canonical (`/a/./b/` and symlinked paths pass through as
 * given); the daemon resolves it on `project_open`, so callers should use the
 * root in its output, not this path.
 *
 * @param raw - the path as typed or passed in the URL
 * @returns the path, or a user-facing error message
 */
export const parse_project_path = (
	raw: string
): Result<{ path: DiskfilePath }, { message: string }> => {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, message: 'path is required' };
	if (trimmed.startsWith('~')) {
		return {
			ok: false,
			message: `path must be absolute — "~" is not expanded, use the full path: ${trimmed}`
		};
	}
	const parsed = parse(DiskfilePath, trimmed);
	if (!parsed.ok) {
		return {
			ok: false,
			message: `${parsed.issues[0]?.message ?? 'invalid path'}: ${trimmed}`
		};
	}
	return { ok: true, path: parsed.value };
};

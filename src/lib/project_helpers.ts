import { parse } from '@fuzdev/fuz_schema/schema.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import { DiskfilePath } from './diskfile_types.ts';
import type { ProjectFallbackJson, ProjectInfoJson, ProjectKind } from './project.svelte.ts';

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
 * `reason` of a `project_open` `refused` focus whose directory couldn't be
 * indexed for a cause other than its absence or a refused listing — the one
 * refusal a later open may get past, so a reopen retries it rather than
 * dropping the focus.
 */
export const ERROR_REPO_INDEX_FAILED = 'repo_index_failed';

/**
 * What to tell the user about a project whose `watch_status` is
 * `degraded`: some of its directories have no file watch, so the daemon
 * rescans them every few seconds instead.
 */
export const PROJECT_DEGRADED_NOTICE =
	"Not every directory has a file watch (likely the system's watch limit) — changes in some show up after a few seconds.";

/** What each kind of project is, as a phrase. */
export const PROJECT_KIND_PHRASES: Record<ProjectKind, string> = {
	registry: 'a registry',
	git_repo: 'a git checkout',
	plain_dir: 'a directory'
};

/**
 * The plain words for the daemon's reasons a registry is passed over, each
 * true of every refusal the daemon reports under it.
 */
const REGISTRY_REFUSAL_PHRASES: Record<string, string> = {
	registry_invalid: "isn't a valid registry",
	registry_unreadable: "can't be read",
	// the file, or a folder from it up to the home folder
	registry_untrusted:
		"isn't trusted: it or a folder above it has another owner or loose permissions",
	// a link whose target is outside the root, or whose text may pass another link
	registry_not_confined: 'is a link out of its folder, or through another link',
	registry_root_in_entry: 'is in a checkout of one of its own repos',
	protected_dir_not_allowed: 'links into a protected folder'
};

/**
 * Why a project isn't the registry found above it, as a clause —
 * `/dev/repos.toml lists no cloned repo holding it`. An `unregistered`
 * project is in none of the registry's present entries, or is the root of a
 * checkout with none present.
 */
export const format_project_fallback = (fallback: ProjectFallbackJson): string => {
	if (fallback.kind === 'unregistered') {
		return `${fallback.registry_path} lists no cloned repo holding it`;
	}
	const { reason } = fallback;
	return `${fallback.registry_path} ${REGISTRY_REFUSAL_PHRASES[reason] ?? `was refused (${reason})`}`;
};

/**
 * Where an open of `path` landed and why, for the notice after it, e.g.
 * `Opened /dev/zzz/src, rooted at /dev/zzz/ — a git checkout; /dev/repos.toml lists no cloned repo holding it.`
 */
export const format_project_opened = (
	path: string,
	project: Pick<ProjectInfoJson, 'root' | 'kind' | 'fallback'>
): string => {
	const at =
		path === project.root || `${path}/` === project.root
			? `Opened ${project.root}`
			: `Opened ${path}, rooted at ${project.root}`;
	const why = project.fallback ? `; ${format_project_fallback(project.fallback)}` : '';
	return `${at} — ${PROJECT_KIND_PHRASES[project.kind]}${why}.`;
};

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

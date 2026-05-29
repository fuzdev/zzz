import {
	PUBLIC_ZZZ_SERVER_HOST,
	PUBLIC_ZZZ_SERVER_PORT,
	PUBLIC_ZZZ_SERVER_PROTOCOL,
	PUBLIC_ZZZ_SERVER_PROXIED_PORT,
	PUBLIC_ZZZ_BACKEND_ARTIFICIAL_DELAY,
	PUBLIC_ZZZ_SERVER_API_PATH,
	PUBLIC_ZZZ_WEBSOCKET_URL,
	PUBLIC_ZZZ_DIR,
	PUBLIC_ZZZ_SCOPED_DIRS,
} from '$env/static/public';

import {
	PathWithLeadingSlash,
	PathWithTrailingSlash,
	PathWithoutTrailingSlash,
} from './zod_helpers.js';

// This module re-exports public environment variables with parsed values.
// It should generally be preferred to using the variables directly.
//
// WARNING: This module imports $env/static/public (SvelteKit build-time) and
// MUST NOT be imported by any module in the Deno compile chain (the CLI under
// `src/lib/zzz/`) — $env doesn't exist in Deno and will crash the compile.

// TODO a lot of these need to be moved to env or config etc
// and maybe some need to be derived (in some/all cases)

// TODO better validation

// TODO maybe remove the SERVER_ prefixes

export const SERVER_PROTOCOL: string = PUBLIC_ZZZ_SERVER_PROTOCOL || 'http';

export const SERVER_HOST: string = PUBLIC_ZZZ_SERVER_HOST || 'localhost';

/**
 * @with_protocol
 * @no_trailing_slash
 */
export const SERVER_URL: string = `${SERVER_PROTOCOL}://${SERVER_HOST}:${PUBLIC_ZZZ_SERVER_PORT}`;

export const SERVER_PROXIED_PORT: number = parseInt(PUBLIC_ZZZ_SERVER_PROXIED_PORT, 10) || 8999;

export const BACKEND_ARTIFICIAL_RESPONSE_DELAY =
	parseInt(PUBLIC_ZZZ_BACKEND_ARTIFICIAL_DELAY, 10) || 0;

/**
 * @trailing_slash
 */
export const ZZZ_DIR = PathWithTrailingSlash.parse(PUBLIC_ZZZ_DIR || '.zzz');

// Zzz directory subdirectories
export const ZZZ_DIR_STATE = 'state';
export const ZZZ_DIR_STATE_COMPLETIONS = 'completions';
export const ZZZ_DIR_RUN = 'run';
export const ZZZ_DIR_CACHE = 'cache'; // TODO implement

/**
 * Comma-separated list of filesystem paths that Zzz can access.
 * Empty array means no scoped filesystem access.
 */
export const ZZZ_SCOPED_DIRS: Array<string> = PUBLIC_ZZZ_SCOPED_DIRS
	? PUBLIC_ZZZ_SCOPED_DIRS.split(',')
			.map((p) => p.trim())
			.filter(Boolean)
	: [];

export const CONTENT_PREVIEW_LENGTH = 100;

/**
 * @leading_slash
 * @no_trailing_slash
 */
export const API_PATH: string =
	(PUBLIC_ZZZ_SERVER_API_PATH &&
		PathWithoutTrailingSlash.parse(PathWithLeadingSlash.parse(PUBLIC_ZZZ_SERVER_API_PATH))) ||
	'/api';

/**
 * @with_protocol
 * @no_trailing_slash
 */
export const API_URL: string = SERVER_URL + API_PATH;

/**
 * @leading_slash
 * @no_trailing_slash
 */
export const API_PATH_FOR_HTTP_RPC: string = API_PATH + '/rpc';

/**
 * @with_protocol
 * @no_trailing_slash
 */
export const API_URL_FOR_HTTP_RPC: string = SERVER_URL + API_PATH_FOR_HTTP_RPC;

// TODO for production does this need to use the host? compute from the other env variables?
/**
 * @with_protocol
 * @no_trailing_slash
 * */
export const WEBSOCKET_URL: string = PUBLIC_ZZZ_WEBSOCKET_URL
	? PathWithoutTrailingSlash.parse(PUBLIC_ZZZ_WEBSOCKET_URL)
	: 'ws://localhost:8999/api/ws';

export const WEBSOCKET_URL_OBJECT: URL | null = WEBSOCKET_URL ? new URL(WEBSOCKET_URL) : null;

/**
 * @leading_slash
 * @no_trailing_slash
 */
export const WEBSOCKET_PATH: string | undefined = WEBSOCKET_URL_OBJECT?.pathname;

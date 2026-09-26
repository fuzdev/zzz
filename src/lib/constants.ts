import {
	PUBLIC_ZZZ_SERVER_HOST,
	PUBLIC_ZZZ_SERVER_PORT,
	PUBLIC_ZZZ_SERVER_PROTOCOL,
	PUBLIC_ZZZ_SERVER_API_PATH,
	PUBLIC_ZZZ_WEBSOCKET_URL
} from '$env/static/public';

import { PathWithLeadingSlash, PathWithoutTrailingSlash } from './zod_helpers.ts';

// This module re-exports public environment variables with parsed values.
// It should generally be preferred to using the variables directly.
//
// WARNING: This module imports $env/static/public (SvelteKit build-time) and
// MUST NOT be imported by any non-SvelteKit context — $env doesn't exist
// outside the SvelteKit build and will crash.

// TODO a lot of these need to be moved to env or config etc
// and maybe some need to be derived (in some/all cases)

// TODO better validation

// TODO maybe remove the SERVER_ prefixes

/**
 * The page's own origin in the browser, `null` during SSR/prerender.
 * Server URLs default to it, so a UI served by `zzzd` talks to the daemon
 * that served it, on whatever host and port that is.
 */
const PAGE_ORIGIN: string | null = typeof location === 'undefined' ? null : location.origin;

export const SERVER_PROTOCOL: string = PUBLIC_ZZZ_SERVER_PROTOCOL || 'http';

export const SERVER_HOST: string = PUBLIC_ZZZ_SERVER_HOST || 'localhost';

/**
 * The server the UI talks to: `PUBLIC_ZZZ_SERVER_*` when
 * `PUBLIC_ZZZ_SERVER_PORT` is set (dev: the Vite server, which proxies
 * `/api`), else the page's origin (the UI served by `zzzd`). Empty during
 * SSR/prerender when unset, making the API URLs root-relative there.
 *
 * @with_protocol
 * @no_trailing_slash
 */
export const SERVER_URL: string = PUBLIC_ZZZ_SERVER_PORT
	? `${SERVER_PROTOCOL}://${SERVER_HOST}:${PUBLIC_ZZZ_SERVER_PORT}`
	: (PAGE_ORIGIN ?? '');

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

/**
 * `PUBLIC_ZZZ_WEBSOCKET_URL` when set (dev: `zzzd` directly, the Vite proxy
 * doesn't carry WebSockets), else `API_PATH + '/ws'` on the page's origin.
 * Empty during SSR/prerender when unset.
 *
 * @with_protocol
 * @no_trailing_slash
 * */
export const WEBSOCKET_URL: string = PUBLIC_ZZZ_WEBSOCKET_URL
	? PathWithoutTrailingSlash.parse(PUBLIC_ZZZ_WEBSOCKET_URL)
	: PAGE_ORIGIN
		? PAGE_ORIGIN.replace(/^http/, 'ws') + API_PATH + '/ws'
		: '';

export const WEBSOCKET_URL_OBJECT: URL | null = WEBSOCKET_URL ? new URL(WEBSOCKET_URL) : null;

/**
 * @leading_slash
 * @no_trailing_slash
 */
export const WEBSOCKET_PATH: string | undefined = WEBSOCKET_URL_OBJECT?.pathname;

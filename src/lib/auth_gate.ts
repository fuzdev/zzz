/**
 * The root layout's auth gate: which routes render without a session or a
 * backend, what the gate shows in place of the app, and where a login or
 * bootstrap returns to.
 *
 * The public routes (about and docs) are plain content, so a static build
 * served without the daemon still renders them — and prerenders them with
 * their content. Every other route needs the daemon: without one the gate
 * says so instead of showing a login form that can't work.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

/** Routes that render without a session or a backend. */
export const PUBLIC_ROUTE_PATHS = ['/about', '/docs'] as const;

/**
 * Whether `pathname` is a public route or below one. A `.html` suffix is
 * ignored: a static server without clean URLs serves the prerendered
 * `about.html` at `/about.html`, and SvelteKit hydrates it as `/about`.
 *
 * @param pathname - the URL pathname, e.g. `page.url.pathname`
 * @param public_paths - the public route paths (resolved against the base path)
 */
export const is_public_route = (
	pathname: string,
	public_paths: ReadonlyArray<string> = PUBLIC_ROUTE_PATHS
): boolean => {
	const route_path = pathname.endsWith('.html') ? pathname.slice(0, -'.html'.length) : pathname;
	return public_paths.some((path) => route_path === path || route_path.startsWith(path + '/'));
};

/**
 * What the gate shows in place of the app:
 *
 * - `checking` — the first session check or the backend probe hasn't settled
 *   (or the session just verified and the app is mounting)
 * - `daemon_unreachable` — no zzz backend answers
 * - `bootstrap` — no account exists yet
 * - `login` — the backend is up and there's no session
 */
export type AuthGateState = 'checking' | 'daemon_unreachable' | 'bootstrap' | 'login';

export interface AuthGateInput {
	/** Whether the first session check has settled — later checks don't show `checking`. */
	session_checked: boolean;
	/** Whether the backend probe has settled. */
	backend_checked: boolean;
	/** Whether a zzz backend answered the probe. */
	backend_reachable: boolean;
	/** `AuthState.verified`. */
	verified: boolean;
	/** `AuthState.needs_bootstrap`. */
	needs_bootstrap: boolean;
}

/**
 * Derive the gate's state. Only the *first* session check shows `checking`:
 * a login or bootstrap in flight keeps its form mounted, so a failure leaves
 * the fields as typed.
 */
export const to_auth_gate_state = (input: AuthGateInput): AuthGateState => {
	if (!input.session_checked || !input.backend_checked || input.verified) return 'checking';
	if (!input.backend_reachable) return 'daemon_unreachable';
	if (input.needs_bootstrap) return 'bootstrap';
	return 'login';
};

/** The zzz backend's liveness route. */
export const HEALTH_PATH = '/health';

/**
 * Probe whether a zzz backend is serving. Only its health reply counts — a
 * static server (or an SPA fallback answering every path with HTML) is not
 * a backend, and neither is a network error.
 *
 * @param fetch_health - fetches the health route (injectable for tests)
 * @returns whether the zzz backend answered
 */
export const probe_backend = async (
	fetch_health: () => Promise<Response> = () => fetch(HEALTH_PATH)
): Promise<boolean> => {
	try {
		const response = await fetch_health();
		if (!response.ok) return false;
		const body: unknown = await response.json();
		return (
			typeof body === 'object' && body !== null && (body as { status?: unknown }).status === 'ok'
		);
	} catch {
		return false;
	}
};

/**
 * Whether a zzz backend answered the root layout's probe — `null` until the
 * probe settles (and during SSR). Set by the root layout as a getter, so
 * public routes can say why they're missing the app: no daemon, or no login.
 */
export const backend_reachable_context = create_context<() => boolean | null>();

/**
 * Where a login or bootstrap returns to: the page the gate replaced, with its
 * query and hash, so a deep link survives logging in. A path starting `//` or
 * `/\` would read as protocol-relative — another origin — so it returns to
 * the root instead.
 *
 * @param url - the current page URL
 * @param root - where an unsafe path falls back to (the resolved `/`)
 */
export const to_auth_redirect = (url: URL, root = '/'): string => {
	const { pathname } = url;
	if (pathname.startsWith('//') || pathname.startsWith('/\\')) return root;
	return pathname + url.search + url.hash;
};

/**
 * Re-checking the session when the backend signals it may be gone.
 *
 * A revoked WebSocket (`WS_CLOSE_SESSION_REVOKED`), an RPC `unauthenticated`
 * error, or a reconnect that keeps failing all hint the session ended —
 * revoked, expired, or logged out elsewhere. Each hint triggers a probe of the
 * account status endpoint, and only a definitive 401 counts: a network error
 * or 5xx means the backend is unreachable, not that the session is invalid,
 * so a daemon restart never logs the user out.
 *
 * A valid session after a revoked socket is a real case, not noise: some
 * revocations close every socket of the account while ending only another
 * session (another tab's logout, an API-token revoke-all), so the caller
 * gets `on_valid` to rebuild its socket.
 *
 * @module
 */

import { ui_fetch } from '@fuzdev/fuz_app/ui/ui_fetch.ts';

/** The fuz_app account status route — 200 with a live session, 401 without. */
export const ACCOUNT_STATUS_PATH = '/api/account/status';

/**
 * What the status probe learned: `valid` (200), `invalid` (401), or `unknown`
 * (network failure or any other status — the session may well be fine).
 */
export type SessionProbe = 'valid' | 'invalid' | 'unknown';

/**
 * Probe the account status endpoint.
 *
 * @param fetch_status - fetches the status route (injectable for tests)
 * @returns what the probe learned about the session
 */
export const probe_session = async (
	fetch_status: () => Promise<Response> = () => ui_fetch(ACCOUNT_STATUS_PATH)
): Promise<SessionProbe> => {
	try {
		const response = await fetch_status();
		if (response.ok) return 'valid';
		return response.status === 401 ? 'invalid' : 'unknown';
	} catch {
		return 'unknown';
	}
};

export interface SessionRecheckOptions {
	/** Probes the session. Defaults to `probe_session`. */
	probe?: () => Promise<SessionProbe>;
	/** Called once the probe finds the session invalid — typically `AuthState.check_session`. */
	on_invalid: () => void | Promise<void>;
	/**
	 * Called once the probe finds the session still valid — e.g. to reconnect
	 * a socket the server closed as revoked (see `Socket.reconnect_revoked`).
	 */
	on_valid?: () => void | Promise<void>;
}

/**
 * Create a coalescing session recheck. Calls made while a recheck is in
 * flight share it, so a burst of `unauthenticated` errors costs one probe.
 *
 * @returns a function that rechecks the session and resolves when done (never rejects)
 */
export const create_session_recheck = (options: SessionRecheckOptions): (() => Promise<void>) => {
	const { probe = probe_session, on_invalid, on_valid } = options;
	let in_flight: Promise<void> | null = null;
	return () =>
		(in_flight ??= (async () => {
			try {
				const result = await probe();
				if (result === 'invalid') await on_invalid();
				else if (result === 'valid') await on_valid?.();
			} catch (error) {
				console.error('[session_recheck] recheck failed:', error);
			} finally {
				in_flight = null;
			}
		})());
};

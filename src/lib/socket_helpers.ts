import { DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT } from '@fuzdev/fuz_app/actions/socket.svelte.ts';

// The heartbeat and reconnect defaults are fuz_app's
// (`DEFAULT_HEARTBEAT_INTERVAL`, `DEFAULT_RECONNECT_DELAY`,
// `DEFAULT_RECONNECT_DELAY_MAX` in `@fuzdev/fuz_app/actions/socket.svelte.ts`).
export const DEFAULT_AUTO_RECONNECT = true;

/** Inclusive range of a millisecond socket setting. */
export interface MsSettingBounds {
	min: number;
	max: number;
}

/** Allowed heartbeat idle intervals — the receive timeout scales with it (see `to_heartbeat_receive_timeout`). */
export const HEARTBEAT_INTERVAL_BOUNDS: MsSettingBounds = { min: 1_000, max: 600_000 };

/**
 * Allowed reconnect delays, for both the base delay and the backoff cap — the
 * floor keeps a bad value from spinning a reconnect loop.
 */
export const RECONNECT_DELAY_BOUNDS: MsSettingBounds = { min: 100, max: 300_000 };

/**
 * Coerce a user-entered millisecond setting — inputs can hand over strings,
 * `null`, or `NaN` — into a whole number within `bounds`.
 *
 * @param value - the raw value
 * @param bounds - the allowed range
 * @returns the clamped value, or `null` when `value` isn't a finite number (the caller keeps the current one)
 */
export const to_bounded_ms = (value: unknown, bounds: MsSettingBounds): number | null => {
	if (value === null || value === '' || typeof value === 'boolean') return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
};

/**
 * The client heartbeat's receive timeout for `interval`: fuz_app's default,
 * raised to 2 × `interval` so an idle socket is never closed before its
 * heartbeat can be answered (the check runs every `interval / 2`, so a
 * heartbeat can leave up to 1.5 × `interval` after the last receive).
 *
 * @param interval - the heartbeat idle interval in ms
 * @returns the receive timeout in ms
 */
// TODO drop once fuz_app's client derives this itself (`resolve_heartbeat_receive_timeout`)
export const to_heartbeat_receive_timeout = (interval: number): number =>
	Math.max(DEFAULT_HEARTBEAT_RECEIVE_TIMEOUT, interval * 2);

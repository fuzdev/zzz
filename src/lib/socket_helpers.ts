// The heartbeat and reconnect defaults are fuz_app's
// (`DEFAULT_HEARTBEAT_INTERVAL`, `DEFAULT_RECONNECT_DELAY`,
// `DEFAULT_RECONNECT_DELAY_MAX` in `@fuzdev/fuz_app/actions/socket.svelte.ts`).
export const DEFAULT_AUTO_RECONNECT = true;

/** Inclusive range of a millisecond socket setting. */
export interface MsSettingBounds {
	min: number;
	max: number;
}

/**
 * Allowed heartbeat idle intervals — fuz_app's client scales the receive
 * timeout with it (`resolve_heartbeat_receive_timeout` in
 * `@fuzdev/fuz_app/actions/socket.svelte.ts`).
 */
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

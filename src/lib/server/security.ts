/**
 * Host header validation middleware for DNS rebinding defense-in-depth.
 *
 * Validates that the Host header matches expected local hostnames.
 * Requests without a Host header are allowed (HTTP/1.0, CLI tools).
 *
 * @module
 */

import type {Handler} from 'hono';

/**
 * Default set of hostnames considered safe for local-only binding.
 * Includes all common ways to address localhost.
 */
export const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	'::1',
]);

/**
 * Addresses that bind to all network interfaces.
 * These are dangerous without authentication because they expose the daemon to the LAN.
 */
export const OPEN_HOST_ADDRESSES: ReadonlySet<string> = new Set(['0.0.0.0', '::', '0']);

/**
 * Check whether a bind address is a wildcard that exposes to the network.
 *
 * @param host - the bind address to check
 * @returns true if the host binds to all interfaces
 */
export const is_open_host = (host: string): boolean => OPEN_HOST_ADDRESSES.has(host);

/**
 * Extract the hostname portion from a Host header value.
 * Handles IPv6 brackets: `[::1]:3000` → `[::1]`
 * Handles regular: `localhost:3000` → `localhost`
 *
 * @param host - the raw Host header value
 * @returns the hostname without port
 */
export const extract_hostname = (host: string): string => {
	// IPv6 in brackets: [::1]:port or [::1]
	if (host.startsWith('[')) {
		const bracket_end = host.indexOf(']');
		if (bracket_end !== -1) {
			return host.slice(0, bracket_end + 1);
		}
		return host;
	}
	// Bare IPv6 without brackets (multiple colons) — return as-is
	// A hostname:port has exactly one colon; IPv6 has multiple
	const first_colon = host.indexOf(':');
	const last_colon = host.lastIndexOf(':');
	if (first_colon !== last_colon) {
		// Multiple colons means bare IPv6 address, not hostname:port
		return host;
	}

	// Regular hostname:port (single colon)
	if (first_colon !== -1) {
		return host.slice(0, first_colon);
	}
	return host;
};

/**
 * Build the set of allowed hostnames for Host header validation
 * based on the server's bind address.
 *
 * When binding to `localhost` or `127.0.0.1`, both are allowed
 * (they refer to the same interface). When binding to `0.0.0.0`,
 * all local hostnames are allowed since we can't know which
 * interface the request arrived on.
 *
 * @param bind_host - the address the server is binding to
 * @returns set of hostnames to accept in the Host header
 */
export const build_allowed_hostnames = (bind_host: string): Set<string> => {
	const normalized = bind_host.toLowerCase();

	if (is_open_host(normalized)) {
		// Bound to all interfaces — allow local hostnames as minimum protection
		return new Set(LOCAL_HOSTNAMES);
	}

	const hostnames = new Set<string>();
	hostnames.add(normalized);

	// localhost resolves to both 127.0.0.1 and [::1] — Deno.serve binds both.
	// A browser connecting via either interface should be allowed.
	if (
		normalized === 'localhost' ||
		normalized === '127.0.0.1' ||
		normalized === '[::1]' ||
		normalized === '::1'
	) {
		hostnames.add('localhost');
		hostnames.add('127.0.0.1');
		hostnames.add('[::1]');
		hostnames.add('::1');
	}

	return hostnames;
};

/**
 * Create middleware that validates the Host header against an allowlist.
 *
 * Blocks requests whose Host header hostname doesn't match any allowed value.
 * The port portion of the Host header is stripped before comparison.
 * Requests without a Host header are allowed through (non-browser clients like curl or CLI).
 *
 * @param allowed_hostnames - set of allowed hostnames (without port)
 * @returns Hono middleware handler
 */
export const create_host_validation_middleware =
	(allowed_hostnames: Set<string>): Handler =>
	(c, next) => {
		const host_header = c.req.header('host');
		if (host_header === undefined) {
			// No Host header — non-browser client (curl, CLI, HTTP/1.0)
			return next();
		}

		const hostname = extract_hostname(host_header).toLowerCase();
		if (allowed_hostnames.has(hostname)) {
			return next();
		}

		return c.json({error: 'forbidden_host'}, 403);
	};

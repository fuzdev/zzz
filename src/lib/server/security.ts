import {escape_regexp} from '@fuzdev/fuz_util/regexp.js';
import type {Handler} from 'hono';

/**
 * Parses ALLOWED_ORIGINS env var into regex matchers for request source verification.
 * This is NOT a CSRF protection mechanism - it's a simple origin/referer allowlist
 * that verifies requests are coming from expected sources.
 *
 * Accepts comma-separated patterns with limited wildcards:
 * - Exact origins: `https://api.example.com`
 * - Wildcard subdomains: `https://*.example.com` (matches exactly one subdomain level)
 * - Multiple wildcards: `https://*.staging.*.example.com` (for deep subdomains)
 * - Wildcard ports: `http://localhost:*` (matches any port or no port)
 * - IPv6 addresses: `http://[::1]:3000`, `https://[2001:db8::1]`
 * - Combined: `https://*.example.com:*`
 *
 * Examples:
 * - `http://localhost:3000,https://prod.example.com`
 * - `https://*.api.example.com,http://127.0.0.1:*`
 * - `http://[::1]:*,https://*.*.corp.example.com:*`
 */
export const parse_allowed_origins = (env_value: string | undefined): Array<RegExp> =>
	env_value
		? env_value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
				.map(origin_pattern_to_regexp)
		: [];

/**
 * Tests if a request source (origin or referer) matches any of the allowed patterns.
 * Pattern matching is case-insensitive for domains (as per web standards).
 */
export const should_allow_origin = (origin: string, allowed_patterns: Array<RegExp>): boolean =>
	allowed_patterns.some((p) => p.test(origin));

/**
 * Middleware that verifies the request source against an allowlist.
 *
 * NOT a CSRF protection - this is a simple origin/referer check that:
 * - Checks the Origin header first (if present)
 * - Falls back to Referer header (if no Origin)
 * - Allows requests without Origin/Referer headers (direct access, curl, etc.)
 *
 * This is useful for:
 * - Protecting locally-running services from being called by
 *   untrusted websites as the user browses the web
 * - Restricting which domains can make requests to your API
 * - Preventing embedding of your service in unexpected sites
 * - Basic source verification (but NOT security-critical CSRF protection)
 *
 * @param allowed_patterns - Array of compiled regex patterns from `parse_allowed_origins`
 */
export const verify_request_source =
	(allowed_patterns: Array<RegExp>): Handler =>
	(c, next) => {
		// Check origin header (preferred, sent by browsers for CORS requests)
		const origin = c.req.header('origin');
		if (origin) {
			if (!should_allow_origin(origin, allowed_patterns)) {
				return c.text('forbidden origin', 403);
			}
			return next();
		}

		// Check referer header (fallback for some requests like gets and navigation)
		const referer = c.req.header('referer');
		if (referer) {
			const referer_origin = extract_origin_from_referer(referer);
			if (!should_allow_origin(referer_origin, allowed_patterns)) {
				return c.text('forbidden referer', 403);
			}
			return next();
		}

		// TODO revisit when we add auth and CSRF protection
		// No origin or referer - usually direct access like curl.
		// Allow because the request is coming from a non-browser source
		// that could be spoofing headers anyway,
		// so we'll assume the user is running trusted code.
		return next();
	};

/**
 * Converts origin patterns with wildcards to regex patterns.
 *
 * Pattern format: protocol://hostname[:port]
 *
 * Wildcard support:
 * - Subdomain wildcards: `*.example.com` matches `sub.example.com` (NOT `example.com`)
 * - Multiple wildcards: `*.*.example.com` matches `api.staging.example.com`
 * - Port wildcards: `example.com:*` matches any port or no port
 * - IPv6 support: `[::1]`, `[2001:db8::1]` (no wildcards in IPv6)
 *
 * Restrictions:
 * - No paths allowed (origins don't include paths)
 * - Wildcards must be complete labels (`*.example.com`, not `*example.com`)
 * - No wildcards in IPv6 addresses
 * - Port wildcards must be `:*` exactly
 *
 * Note: Patterns are normalized via URL constructor. IPv4-mapped IPv6 addresses
 * like `[::ffff:127.0.0.1]` will be normalized to `[::ffff:7f00:1]`. IPv6 zone
 * identifiers (e.g., `%eth0`) are not supported.
 *
 * @throws {Error} If pattern format is invalid
 */
const origin_pattern_to_regexp = (pattern: string): RegExp => {
	// Quick validation: no paths, query strings, or fragments allowed
	const protocol_idx = pattern.indexOf('://');
	if (protocol_idx === -1) {
		throw new Error(`Invalid origin pattern: ${pattern}`);
	}
	const after_protocol = pattern.slice(protocol_idx + 3);
	if (/[/?#]/.test(after_protocol)) {
		throw new Error(`Paths not allowed in origin patterns: ${pattern}`);
	}

	// Check for wildcards in IPv6 before URL parsing (URL rejects these with unhelpful error)
	const ipv6_match = /^\[([^\]]+)\]/.exec(after_protocol);
	if (ipv6_match?.[1]?.includes('*')) {
		throw new Error(`Wildcards not allowed in IPv6 addresses: ${pattern}`);
	}

	// Handle port wildcard - must be at the end
	let port_wildcard = false;
	let parse_pattern = pattern;
	if (pattern.endsWith(':*')) {
		port_wildcard = true;
		parse_pattern = pattern.slice(0, -2);
	}

	// Parse with URL constructor for robust handling of protocol, hostname, port, IPv6
	let url: URL;
	try {
		url = new URL(parse_pattern);
	} catch {
		throw new Error(`Invalid origin pattern: ${pattern}`);
	}

	// Validate protocol is http or https
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Invalid origin pattern: ${pattern}`);
	}

	const hostname = url.hostname;
	const is_ipv6 = hostname.startsWith('[');

	// For regular hostnames, wildcards must be complete labels
	if (!is_ipv6) {
		for (const label of hostname.split('.')) {
			if (label.includes('*') && label !== '*') {
				throw new Error(
					`Wildcards must be complete labels (e.g., *.example.com, not *example.com): ${pattern}`,
				);
			}
		}
	}

	// Build regex pattern
	let regex_pattern = '^' + escape_regexp(url.protocol) + '//';

	// Handle hostname
	if (is_ipv6) {
		// IPv6 address - URL.hostname includes brackets
		regex_pattern += escape_regexp(hostname);
	} else {
		// Regular hostname - process wildcards
		const labels = hostname.split('.');
		regex_pattern += labels
			.map((label) => (label === '*' ? '[^./:]+' : escape_regexp(label)))
			.join('\\.');
	}

	// Handle port
	if (port_wildcard) {
		// Optional port (matches both with and without port)
		regex_pattern += '(:\\d+)?';
	} else {
		// URL normalizes default ports (80 for HTTP, 443 for HTTPS) away,
		// so check original pattern for explicit port when url.port is empty
		let port = url.port;
		if (!port) {
			const port_match = /:(\d+)$/.exec(parse_pattern);
			if (port_match?.[1]) {
				port = port_match[1];
			}
		}
		if (port) {
			regex_pattern += ':' + escape_regexp(port);
		}
	}

	regex_pattern += '$';

	// Case-insensitive matching (web standards specify domains are case-insensitive)
	return new RegExp(regex_pattern, 'i');
};

/**
 * Extracts the origin from a referer URL, removing the path, query string, and fragment.
 *
 * @param referer - The referer URL (e.g., `https://example.com/path?query#hash`)
 * @returns The origin part (e.g., `https://example.com`)
 */
const extract_origin_from_referer = (referer: string): string => {
	try {
		return new URL(referer).origin;
	} catch {
		// If URL parsing fails, return the original string
		// (it will likely fail pattern matching anyway)
		return referer;
	}
};

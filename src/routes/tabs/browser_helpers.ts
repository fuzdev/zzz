/**
 * The `src` for an `external_url` browser tab's iframe, or `null` when the URL
 * must not load there: only absolute `http:`/`https:` URLs on another origin
 * are allowed. Other schemes (`javascript:`, `data:`, `blob:`, …) and zzz's own
 * origin are refused, so a tab can't run script against the app.
 *
 * @param url - the tab's URL as entered
 * @param app_origin - the origin zzz is served from
 * @returns the normalized URL, or `null` if it's refused
 */
export const to_browser_tab_iframe_src = (url: string, app_origin: string): string | null => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	if (parsed.origin === app_origin) return null;
	return parsed.href;
};

// a scheme prefix, which may also be the host of `host:port` like `localhost:5173`
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):/i;
// schemes whose URLs can start `scheme:digits`, which aren't `host:port`
const NON_HTTP_SCHEMES = new Set(['tel', 'sms', 'mailto', 'data', 'javascript', 'blob', 'file']);
// hosts served over plain http by default
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalizes a URL typed into the browser's address bar: an input with no
 * scheme (`example.com/a`, `localhost:5173`) gets `https://` — or `http://`
 * for `localhost`, `127.0.0.1`, and `[::1]` — when that makes a valid URL.
 * Inputs with a scheme, app paths (`/newtab`, `~newtab`), and anything that
 * doesn't parse pass through trimmed — what loads is still decided by
 * `to_browser_tab_iframe_src`.
 *
 * @param input - the address bar's text
 * @returns the URL to navigate to
 */
export const to_browser_tab_url = (input: string): string => {
	const trimmed = input.trim();
	if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('~')) return trimmed;
	const scheme = SCHEME_PREFIX.exec(trimmed)?.[1];
	if (
		scheme &&
		(NON_HTTP_SCHEMES.has(scheme.toLowerCase()) || !/^\d/.test(trimmed.slice(scheme.length + 1)))
	) {
		return trimmed;
	}
	let hostname: string;
	try {
		({ hostname } = new URL(`https://${trimmed}`));
	} catch {
		return trimmed;
	}
	return `${LOCAL_HOSTNAMES.has(hostname) ? 'http' : 'https'}://${trimmed}`;
};

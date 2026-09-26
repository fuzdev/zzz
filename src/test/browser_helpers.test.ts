import { test, describe, assert } from 'vitest';

import { to_browser_tab_iframe_src, to_browser_tab_url } from '$routes/tabs/browser_helpers.ts';

const APP_ORIGIN = 'http://localhost:4460';

describe('to_browser_tab_iframe_src', () => {
	test('allows http and https URLs on other origins', () => {
		assert.strictEqual(
			to_browser_tab_iframe_src('https://example.com/a?b=c', APP_ORIGIN),
			'https://example.com/a?b=c'
		);
		assert.strictEqual(
			to_browser_tab_iframe_src('http://localhost:5173/', APP_ORIGIN),
			'http://localhost:5173/'
		);
	});

	test('refuses the app origin', () => {
		assert.strictEqual(to_browser_tab_iframe_src(`${APP_ORIGIN}/chats`, APP_ORIGIN), null);
	});

	test('refuses other schemes and relative or malformed URLs', () => {
		for (const url of [
			// eslint-disable-next-line no-script-url
			'javascript:alert(window.parent.app)',
			'data:text/html,<script>1</script>',
			'blob:http://localhost:4460/abc',
			'file:///etc/passwd',
			'/newtab',
			'example.com',
			''
		]) {
			assert.strictEqual(to_browser_tab_iframe_src(url, APP_ORIGIN), null, url);
		}
	});
});

describe('to_browser_tab_url', () => {
	test('adds `https://` to an input without a scheme', () => {
		assert.strictEqual(to_browser_tab_url('example.com'), 'https://example.com');
		assert.strictEqual(to_browser_tab_url(' example.com/a?b '), 'https://example.com/a?b');
	});

	test('adds `http://` to a local host, with or without a port', () => {
		for (const url of [
			'localhost',
			'localhost:5173',
			'localhost:5173/a',
			'127.0.0.1',
			'127.0.0.1:8080',
			'[::1]',
			'[::1]:8080'
		]) {
			assert.strictEqual(to_browser_tab_url(url), `http://${url}`, url);
		}
		assert.strictEqual(
			to_browser_tab_url('localhost.example.com'),
			'https://localhost.example.com'
		);
	});

	test('passes through non-http schemes that look like `host:port`', () => {
		for (const url of ['tel:5551234', 'sms:5551234', 'mailto:123@example.com', 'data:1']) {
			assert.strictEqual(to_browser_tab_url(url), url, url);
			assert.strictEqual(to_browser_tab_iframe_src(to_browser_tab_url(url), APP_ORIGIN), null);
		}
	});

	test('passes through inputs with a scheme, app paths, and unparseable input', () => {
		for (const url of [
			'https://example.com',
			'http://example.com',
			// eslint-disable-next-line no-script-url
			'javascript:alert(1)',
			'data:text/html,hi',
			'/newtab',
			'~newtab',
			''
		]) {
			assert.strictEqual(to_browser_tab_url(url), url, url);
		}
		assert.strictEqual(to_browser_tab_url('a b'), 'a b');
	});
});

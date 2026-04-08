import {describe, test, vi, assert} from 'vitest';
import type {Handler} from 'hono';

import {
	extract_hostname,
	build_allowed_hostnames,
	create_host_validation_middleware,
	LOCAL_HOSTNAMES,
	is_open_host,
} from '../../lib/server/security.js';

// Test helpers (same pattern as security.test.ts)
const create_mock_context = (headers: Record<string, string> = {}) => {
	const next = vi.fn();
	const json = vi.fn((content: unknown, status: number) => ({content, status}));

	const normalized_headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized_headers[key.toLowerCase()] = value;
	}

	const c = {
		req: {
			header: (name: string) => normalized_headers[name.toLowerCase()],
		},
		json,
	};

	return {c, next, json};
};

const test_middleware_allows = async (handler: Handler, headers: Record<string, string>) => {
	const {c, next} = create_mock_context(headers);
	await handler(c as any, next);
	assert.ok(next.mock.calls.length > 0, 'middleware should call next()');
};

const test_middleware_blocks = async (handler: Handler, headers: Record<string, string>) => {
	const {c, next, json} = create_mock_context(headers);
	await handler(c as any, next);
	assert.strictEqual(next.mock.calls.length, 0, 'middleware should not call next()');
	assert.deepEqual(json.mock.calls[0], [{error: 'forbidden_host'}, 403]);
};

describe('extract_hostname', () => {
	test('extracts hostname from host:port', () => {
		assert.strictEqual(extract_hostname('localhost:4460'), 'localhost');
	});

	test('returns hostname when no port', () => {
		assert.strictEqual(extract_hostname('localhost'), 'localhost');
	});

	test('extracts IPv4 from host:port', () => {
		assert.strictEqual(extract_hostname('127.0.0.1:4460'), '127.0.0.1');
	});

	test('handles IPv6 in brackets with port', () => {
		assert.strictEqual(extract_hostname('[::1]:4460'), '[::1]');
	});

	test('handles IPv6 in brackets without port', () => {
		assert.strictEqual(extract_hostname('[::1]'), '[::1]');
	});

	test('handles bare IPv6 without brackets', () => {
		// edge case — some clients might send this
		assert.strictEqual(extract_hostname('::1'), '::1');
	});

	test('handles full IPv6 in brackets', () => {
		assert.strictEqual(
			extract_hostname('[2001:db8::8a2e:370:7334]:8443'),
			'[2001:db8::8a2e:370:7334]',
		);
	});

	test('handles empty string', () => {
		assert.strictEqual(extract_hostname(''), '');
	});

	test('handles just a colon', () => {
		assert.strictEqual(extract_hostname(':'), '');
	});

	test('handles just brackets', () => {
		assert.strictEqual(extract_hostname('[]'), '[]');
	});

	test('handles unclosed bracket', () => {
		assert.strictEqual(extract_hostname('[::1'), '[::1');
	});
});

describe('is_open_host', () => {
	test('identifies 0.0.0.0 as open', () => {
		assert.ok(is_open_host('0.0.0.0'));
	});

	test('identifies :: as open', () => {
		assert.ok(is_open_host('::'));
	});

	test('identifies 0 as open', () => {
		assert.ok(is_open_host('0'));
	});

	test('localhost is not open', () => {
		assert.ok(!is_open_host('localhost'));
	});

	test('127.0.0.1 is not open', () => {
		assert.ok(!is_open_host('127.0.0.1'));
	});
});

describe('build_allowed_hostnames', () => {
	test('localhost includes all loopback forms', () => {
		const hostnames = build_allowed_hostnames('localhost');
		assert.ok(hostnames.has('localhost'));
		assert.ok(hostnames.has('127.0.0.1'));
		assert.ok(hostnames.has('[::1]'));
		assert.ok(hostnames.has('::1'));
	});

	test('127.0.0.1 includes all loopback forms', () => {
		const hostnames = build_allowed_hostnames('127.0.0.1');
		assert.ok(hostnames.has('localhost'));
		assert.ok(hostnames.has('127.0.0.1'));
		assert.ok(hostnames.has('[::1]'));
	});

	test('[::1] includes all loopback forms', () => {
		const hostnames = build_allowed_hostnames('[::1]');
		assert.ok(hostnames.has('[::1]'));
		assert.ok(hostnames.has('::1'));
		assert.ok(hostnames.has('localhost'));
		assert.ok(hostnames.has('127.0.0.1'));
	});

	test('::1 includes all loopback forms', () => {
		const hostnames = build_allowed_hostnames('::1');
		assert.ok(hostnames.has('[::1]'));
		assert.ok(hostnames.has('::1'));
		assert.ok(hostnames.has('localhost'));
	});

	test('0.0.0.0 includes all local hostnames', () => {
		const hostnames = build_allowed_hostnames('0.0.0.0');
		for (const h of LOCAL_HOSTNAMES) {
			assert.ok(hostnames.has(h), `should include ${h}`);
		}
	});

	test(':: includes all local hostnames', () => {
		const hostnames = build_allowed_hostnames('::');
		for (const h of LOCAL_HOSTNAMES) {
			assert.ok(hostnames.has(h), `should include ${h}`);
		}
	});

	test('custom hostname only includes itself', () => {
		const hostnames = build_allowed_hostnames('myhost.local');
		assert.ok(hostnames.has('myhost.local'));
		assert.strictEqual(hostnames.size, 1);
	});

	test('is case-insensitive', () => {
		const hostnames = build_allowed_hostnames('LocalHost');
		assert.ok(hostnames.has('localhost'));
		assert.ok(hostnames.has('127.0.0.1'));
	});
});

describe('create_host_validation_middleware', () => {
	const localhost_middleware = create_host_validation_middleware(
		build_allowed_hostnames('localhost'),
	);

	describe('allows valid hosts', () => {
		test('allows localhost:port', async () => {
			await test_middleware_allows(localhost_middleware, {host: 'localhost:4460'});
		});

		test('allows localhost without port', async () => {
			await test_middleware_allows(localhost_middleware, {host: 'localhost'});
		});

		test('allows 127.0.0.1:port', async () => {
			await test_middleware_allows(localhost_middleware, {host: '127.0.0.1:4460'});
		});

		test('allows case-insensitive localhost', async () => {
			await test_middleware_allows(localhost_middleware, {host: 'LocalHost:4460'});
		});

		test('allows requests without Host header', async () => {
			await test_middleware_allows(localhost_middleware, {});
		});

		test('allows requests with other headers but no Host', async () => {
			await test_middleware_allows(localhost_middleware, {
				'user-agent': 'curl/7.64.1',
				accept: '*/*',
			});
		});
	});

	describe('blocks invalid hosts', () => {
		test('blocks evil.com', async () => {
			await test_middleware_blocks(localhost_middleware, {host: 'evil.com:4460'});
		});

		test('blocks evil.com without port', async () => {
			await test_middleware_blocks(localhost_middleware, {host: 'evil.com'});
		});

		test('blocks 192.168.1.1', async () => {
			await test_middleware_blocks(localhost_middleware, {host: '192.168.1.1:4460'});
		});

		test('allows [::1] when bound to localhost', async () => {
			// localhost resolves to both IPv4 and IPv6 loopback
			await test_middleware_allows(localhost_middleware, {host: '[::1]:4460'});
		});
	});

	describe('IPv6 binding', () => {
		const ipv6_middleware = create_host_validation_middleware(build_allowed_hostnames('[::1]'));

		test('allows [::1]:port', async () => {
			await test_middleware_allows(ipv6_middleware, {host: '[::1]:4460'});
		});

		test('allows bare ::1', async () => {
			await test_middleware_allows(ipv6_middleware, {host: '::1'});
		});

		test('allows localhost when bound to [::1]', async () => {
			// all loopback forms are aliases
			await test_middleware_allows(ipv6_middleware, {host: 'localhost:4460'});
		});

		test('blocks evil.com when bound to [::1]', async () => {
			await test_middleware_blocks(ipv6_middleware, {host: 'evil.com:4460'});
		});
	});

	describe('build_allowed_hostnames for 0.0.0.0 (used if auth is added later)', () => {
		const open_middleware = create_host_validation_middleware(build_allowed_hostnames('0.0.0.0'));

		test('allows localhost', async () => {
			await test_middleware_allows(open_middleware, {host: 'localhost:4460'});
		});

		test('allows 127.0.0.1', async () => {
			await test_middleware_allows(open_middleware, {host: '127.0.0.1:4460'});
		});

		test('allows [::1]', async () => {
			await test_middleware_allows(open_middleware, {host: '[::1]:4460'});
		});

		test('blocks external hostname even on 0.0.0.0', async () => {
			await test_middleware_blocks(open_middleware, {host: 'evil.com:4460'});
		});

		test('blocks LAN IP even on 0.0.0.0', async () => {
			await test_middleware_blocks(open_middleware, {host: '192.168.1.100:4460'});
		});
	});
});

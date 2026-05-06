import {describe, test, vi, assert} from 'vitest';
import type {Handler} from 'hono';

import {
	parse_allowed_origins,
	should_allow_origin,
	verify_request_source,
} from '@fuzdev/fuz_app/http/origin.js';

// Test helpers
const create_mock_context = (headers: Record<string, string> = {}) => {
	const next = vi.fn();
	const json = vi.fn((content: unknown, status: number) => ({content, status}));

	// Convert all header keys to lowercase for case-insensitive lookup
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

const test_pattern = (
	pattern: string,
	valid_origins: Array<string>,
	invalid_origins: Array<string>,
) => {
	const regexps = parse_allowed_origins(pattern);

	for (const origin of valid_origins) {
		assert.ok(should_allow_origin(origin, regexps), `${origin} should match ${pattern}`);
	}

	for (const origin of invalid_origins) {
		assert.ok(!should_allow_origin(origin, regexps), `${origin} should not match ${pattern}`);
	}
};

const test_middleware_allows = async (handler: Handler, headers: Record<string, string>) => {
	const {c, next} = create_mock_context(headers);
	await handler(c as any, next);
	assert.ok(next.mock.calls.length > 0);
};

const test_middleware_blocks = async (
	handler: Handler,
	headers: Record<string, string>,
	expected_error: string,
	expected_status = 403,
) => {
	const {c, next, json} = create_mock_context(headers);
	const result = await handler(c as any, next);
	assert.strictEqual(next.mock.calls.length, 0);
	assert.deepEqual(json.mock.calls[0], [{error: expected_error}, expected_status]);
	assert.deepEqual(result, {content: {error: expected_error}, status: expected_status});
};

describe('parse_allowed_origins', () => {
	test('returns empty array for undefined', () => {
		assert.deepEqual(parse_allowed_origins(undefined), []);
	});

	test('returns empty array for empty string', () => {
		assert.deepEqual(parse_allowed_origins(''), []);
	});

	test('parses single origin', () => {
		const patterns = parse_allowed_origins('http://localhost:3000');
		assert.strictEqual(patterns.length, 1);
		assert.instanceOf(patterns[0], RegExp);
	});

	test('parses multiple comma-separated origins', () => {
		const patterns = parse_allowed_origins('http://localhost:3000,https://example.com');
		assert.strictEqual(patterns.length, 2);
	});

	test('trims whitespace from origins', () => {
		const patterns = parse_allowed_origins('  http://localhost:3000  ,  https://example.com  ');
		assert.strictEqual(patterns.length, 2);
	});

	test('filters out empty entries', () => {
		const patterns = parse_allowed_origins('http://localhost:3000,,https://example.com,');
		assert.strictEqual(patterns.length, 2);
	});

	test('handles complex patterns', () => {
		const patterns = parse_allowed_origins(
			'https://*.example.com,http://localhost:*,https://*.test.com:*',
		);
		assert.strictEqual(patterns.length, 3);
	});
});

describe('should_allow_origin', () => {
	test('returns false for empty patterns', () => {
		assert.ok(!should_allow_origin('http://example.com', []));
	});

	test('matches exact origins', () => {
		const patterns = parse_allowed_origins('http://example.com');
		assert.ok(should_allow_origin('http://example.com', patterns));
		assert.ok(!should_allow_origin('https://example.com', patterns));
	});

	test('matches any of multiple patterns', () => {
		const patterns = parse_allowed_origins('http://localhost:3000,https://example.com');
		assert.ok(should_allow_origin('http://localhost:3000', patterns));
		assert.ok(should_allow_origin('https://example.com', patterns));
		assert.ok(!should_allow_origin('http://other.com', patterns));
	});
});

describe('pattern_to_regexp', () => {
	describe('exact patterns', () => {
		test('matches exact http origins', () => {
			test_pattern(
				'http://example.com',
				['http://example.com'],
				['https://example.com', 'http://example.org', 'http://sub.example.com'],
			);
		});

		test('matches exact https origins', () => {
			test_pattern(
				'https://example.com',
				['https://example.com'],
				['http://example.com', 'https://example.org', 'https://sub.example.com'],
			);
		});

		test('matches origins with ports', () => {
			test_pattern(
				'http://localhost:3000',
				['http://localhost:3000'],
				['http://localhost', 'http://localhost:3001', 'https://localhost:3000'],
			);
		});

		test('throws on paths in patterns', () => {
			assert.throws(
				() => parse_allowed_origins('http://example.com/api'),
				/Paths not allowed in origin patterns/,
			);
			assert.throws(
				() => parse_allowed_origins('https://example.com/api/v1'),
				/Paths not allowed in origin patterns/,
			);
			assert.throws(
				() => parse_allowed_origins('http://localhost:3000/'),
				/Paths not allowed in origin patterns/,
			);
		});

		test('matches IPv6 localhost', () => {
			test_pattern(
				'http://[::1]:3000',
				['http://[::1]:3000'],
				['http://[::1]', 'http://[::1]:3001', 'https://[::1]:3000', 'http://::1:3000'],
			);
		});

		test('matches full IPv6 addresses', () => {
			test_pattern(
				'https://[2001:db8:85a3::8a2e:370:7334]:8443',
				['https://[2001:db8:85a3::8a2e:370:7334]:8443'],
				[
					'https://[2001:db8:85a3::8a2e:370:7334]',
					'https://[2001:db8:85a3::8a2e:370:7334]:8444',
					'http://[2001:db8:85a3::8a2e:370:7334]:8443',
				],
			);
		});

		test('matches IPv6 addresses without port', () => {
			test_pattern(
				'http://[2001:db8::1]',
				['http://[2001:db8::1]'],
				['http://[2001:db8::1]:80', 'https://[2001:db8::1]', 'http://2001:db8::1'],
			);
		});

		test('matches IPv4-mapped IPv6 addresses', () => {
			// Note: URL constructor normalizes IPv4-mapped addresses to hex format
			// [::ffff:127.0.0.1] becomes [::ffff:7f00:1]
			test_pattern(
				'http://[::ffff:7f00:1]:3000',
				['http://[::ffff:7f00:1]:3000'],
				[
					'http://[::ffff:7f00:1]',
					'http://[::ffff:7f00:1]:3001',
					'http://127.0.0.1:3000', // Regular IPv4 should not match
				],
			);
		});

		test('matches IPv4-mapped IPv6 without port', () => {
			// Note: URL constructor normalizes IPv4-mapped addresses to hex format
			// [::ffff:192.168.1.1] becomes [::ffff:c0a8:101]
			test_pattern(
				'https://[::ffff:c0a8:101]',
				['https://[::ffff:c0a8:101]'],
				['https://[::ffff:c0a8:101]:443', 'https://192.168.1.1', 'http://[::ffff:c0a8:101]'],
			);
		});
	});

	describe('wildcard subdomains', () => {
		test('matches exactly one subdomain level', () => {
			test_pattern(
				'https://*.example.com',
				['https://sub.example.com', 'https://api.example.com', 'https://www.example.com'],
				[
					'https://example.com', // No subdomain - should NOT match
					'https://deep.sub.example.com', // Two levels deep - should NOT match
					'https://very.deep.sub.example.com', // Three levels deep - should NOT match
					'http://sub.example.com', // Wrong protocol
					'https://example.org', // Wrong domain
					'https://subexample.com', // No dot separator
					'https://sub.example.com.evil.com', // Domain suffix attack
				],
			);
		});

		test('multiple wildcards for deep subdomains', () => {
			test_pattern(
				'https://*.*.example.com',
				[
					'https://api.staging.example.com',
					'https://www.prod.example.com',
					'https://service.region.example.com',
				],
				[
					'https://staging.example.com', // Only one level
					'https://api.staging.prod.example.com', // Three levels
					'https://example.com', // No subdomains
				],
			);
		});

		test('three wildcard levels', () => {
			test_pattern(
				'https://*.*.*.example.com',
				['https://api.v2.staging.example.com', 'https://service.region.prod.example.com'],
				[
					'https://api.staging.example.com', // Only two levels
					'https://api.v2.staging.prod.example.com', // Four levels
				],
			);
		});

		test('wildcard subdomain with port', () => {
			test_pattern(
				'https://*.example.com:443',
				['https://sub.example.com:443', 'https://api.example.com:443'],
				[
					'https://example.com:443',
					'https://sub.example.com',
					'https://sub.example.com:444',
					'https://deep.sub.example.com:443',
				],
			);
		});

		test('wildcard at different positions', () => {
			test_pattern(
				'https://api.*.example.com',
				[
					'https://api.staging.example.com',
					'https://api.prod.example.com',
					'https://api.v2.example.com',
				],
				[
					'https://staging.api.example.com', // Wrong position
					'https://api.example.com', // Missing middle part
					'https://api.staging.prod.example.com', // Too many parts
				],
			);
		});

		test('ensures wildcards cannot match dots', () => {
			const patterns = parse_allowed_origins('https://*.example.com');
			// The wildcard should match 'safe' but not 'safe.evil'
			assert.ok(should_allow_origin('https://safe.example.com', patterns));
			assert.ok(!should_allow_origin('https://safe.evil.example.com', patterns));
			// This is critical - the wildcard should not be able to match across dots
			assert.ok(!should_allow_origin('https://safe.com.evil.com.example.com', patterns));
		});
	});

	describe('wildcard ports', () => {
		test('matches any port or no port', () => {
			test_pattern(
				'http://localhost:*',
				['http://localhost', 'http://localhost:3000', 'http://localhost:8080'],
				['https://localhost', 'http://127.0.0.1:3000'],
			);
		});

		test('wildcard port with exact hostname', () => {
			test_pattern(
				'https://api.example.com:*',
				['https://api.example.com', 'https://api.example.com:443', 'https://api.example.com:8443'],
				['http://api.example.com:443', 'https://example.com:443'],
			);
		});

		test('wildcard port with IPv6 localhost', () => {
			test_pattern(
				'http://[::1]:*',
				['http://[::1]', 'http://[::1]:3000', 'http://[::1]:8080', 'http://[::1]:65535'],
				['https://[::1]', 'http://[::1:3000', 'http://::1:3000'],
			);
		});

		test('wildcard port with full IPv6 address', () => {
			test_pattern(
				'https://[2001:db8::8a2e:370:7334]:*',
				[
					'https://[2001:db8::8a2e:370:7334]',
					'https://[2001:db8::8a2e:370:7334]:443',
					'https://[2001:db8::8a2e:370:7334]:8443',
				],
				['http://[2001:db8::8a2e:370:7334]:443', 'https://[2001:db8::8a2e:370:7335]:443'],
			);
		});
	});

	describe('combined wildcards', () => {
		test('wildcard subdomain and port', () => {
			test_pattern(
				'https://*.example.com:*',
				['https://sub.example.com', 'https://sub.example.com:443', 'https://api.example.com:8443'],
				[
					'https://example.com', // No subdomain
					'https://deep.sub.example.com', // Two levels deep
					'https://deep.sub.example.com:443', // Two levels deep with port
					'http://sub.example.com', // Wrong protocol
					'https://example.org:443', // Wrong domain
				],
			);
		});

		test('multiple subdomain wildcards with wildcard port', () => {
			test_pattern(
				'https://*.*.example.com:*',
				[
					'https://api.staging.example.com',
					'https://api.staging.example.com:443',
					'https://www.prod.example.com:8443',
				],
				[
					'https://staging.example.com:443', // Only one level
					'https://api.staging.prod.example.com', // Three levels
				],
			);
		});
	});

	describe('error handling', () => {
		test('throws on invalid pattern format', () => {
			assert.throws(() => parse_allowed_origins('not-a-url'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('ftp://example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('//example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('*.example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('example.com'), /Invalid origin pattern/);
			assert.throws(() => parse_allowed_origins('localhost:3000'), /Invalid origin pattern/);
		});

		test('throws on wildcards in wrong positions', () => {
			assert.throws(
				() => parse_allowed_origins('http://ex*ample.com'),
				/Wildcards must be complete labels/,
			);
			assert.throws(
				() => parse_allowed_origins('http://example*.com'),
				/Wildcards must be complete labels/,
			);
			assert.throws(
				() => parse_allowed_origins('http://*example.com'),
				/Wildcards must be complete labels/,
			);
			assert.throws(
				() => parse_allowed_origins('http://example.*com'),
				/Wildcards must be complete labels/,
			);
		});

		test('throws on invalid port wildcards', () => {
			assert.throws(
				() => parse_allowed_origins('http://example.com:*000'),
				/Invalid origin pattern/,
			);
			assert.throws(() => parse_allowed_origins('http://example.com:3*'), /Invalid origin pattern/);
		});

		test('throws on wildcards in IPv6 addresses', () => {
			assert.throws(
				() => parse_allowed_origins('http://[*::1]:3000'),
				/Wildcards not allowed in IPv6 addresses/,
			);
			assert.throws(
				() => parse_allowed_origins('https://[2001:db8:*::1]'),
				/Wildcards not allowed in IPv6 addresses/,
			);
			assert.throws(
				() => parse_allowed_origins('http://[::ffff:*.0.0.1]:8080'),
				/Wildcards not allowed in IPv6 addresses/,
			);
		});
	});

	describe('case sensitivity', () => {
		test('domain matching is case-insensitive', () => {
			const patterns = parse_allowed_origins('https://example.com');

			// All these should match
			assert.ok(should_allow_origin('https://example.com', patterns));
			assert.ok(should_allow_origin('https://Example.com', patterns));
			assert.ok(should_allow_origin('https://EXAMPLE.COM', patterns));
			assert.ok(should_allow_origin('https://ExAmPlE.cOm', patterns));
		});

		test('protocol is also case-insensitive due to regex i flag', () => {
			const patterns = parse_allowed_origins('https://example.com');

			// These should match (case-insensitive regex)
			assert.ok(should_allow_origin('https://example.com', patterns));
			assert.ok(should_allow_origin('https://Example.com', patterns));
			assert.ok(should_allow_origin('https://EXAMPLE.COM', patterns));

			// Different protocol should NOT match
			assert.ok(!should_allow_origin('http://example.com', patterns));

			// Note: The regex uses 'i' flag making the entire pattern case-insensitive
			// In practice, browsers always send lowercase protocols, but our regex would match this
			assert.ok(should_allow_origin('HTTPS://example.com', patterns));
		});

		test('case-insensitive matching with wildcards', () => {
			const patterns = parse_allowed_origins('https://*.example.com');

			assert.ok(should_allow_origin('https://API.example.com', patterns));
			assert.ok(should_allow_origin('https://api.EXAMPLE.com', patterns));
			assert.ok(should_allow_origin('https://Api.Example.Com', patterns));
		});

		test('case-insensitive with IPv6', () => {
			// IPv6 addresses can have hexadecimal characters that are case-insensitive
			const patterns = parse_allowed_origins('https://[2001:DB8::1]');

			assert.ok(should_allow_origin('https://[2001:db8::1]', patterns));
			assert.ok(should_allow_origin('https://[2001:DB8::1]', patterns));
			assert.ok(should_allow_origin('https://[2001:dB8::1]', patterns));
		});
	});

	describe('special cases', () => {
		test('handles special characters in domain names', () => {
			test_pattern(
				'https://ex-ample.com',
				['https://ex-ample.com'],
				['https://example.com', 'https://ex_ample.com'],
			);
		});

		test('handles numeric ports', () => {
			test_pattern(
				'http://localhost:8080',
				['http://localhost:8080'],
				['http://localhost:80', 'http://localhost:08080'],
			);
		});

		test('handles hyphenated domain names with wildcards', () => {
			test_pattern(
				'https://*.my-example.com',
				['https://api.my-example.com', 'https://www.my-example.com'],
				['https://my-example.com', 'https://api.myexample.com'],
			);
		});

		test('handles unusual but valid ports', () => {
			test_pattern(
				'http://example.com:65535',
				['http://example.com:65535'],
				['http://example.com:65536', 'http://example.com'],
			);
		});

		test('handles very long origin strings', () => {
			const long_subdomain = 'a'.repeat(63) + '.example.com';
			const patterns = parse_allowed_origins(`https://*.example.com`);
			assert.ok(should_allow_origin(`https://${long_subdomain}`, patterns));
		});
	});

	describe('edge cases', () => {
		test('handles IPv6 addresses', () => {
			// Note: Zone identifiers (e.g., %lo0) are not supported by URL constructor
			const patterns = parse_allowed_origins('http://[::1]:3000,https://[2001:db8::1]');
			assert.strictEqual(patterns.length, 2);

			// Test various IPv6 formats
			assert.ok(should_allow_origin('http://[::1]:3000', patterns));
			assert.ok(should_allow_origin('https://[2001:db8::1]', patterns));

			// Should not match without brackets
			assert.ok(!should_allow_origin('http://::1:3000', patterns));
		});

		test('handles various IPv6 formats', () => {
			// Test compressed zeros
			test_pattern(
				'https://[2001:db8::8a2e:370:7334]',
				['https://[2001:db8::8a2e:370:7334]'],
				['https://[2001:db8:0:0:8a2e:370:7334]'], // Different representation should not match exactly
			);

			// Note: Zone identifiers (e.g., %eth0) are not supported by URL constructor
			// If you need zone identifiers, use the literal normalized form
		});

		test('handles IPv6 edge cases', () => {
			// Loopback variations
			test_pattern(
				'http://[::1]',
				['http://[::1]'],
				['http://[0:0:0:0:0:0:0:1]', 'http://[::0:1]'], // Different representations
			);

			// IPv4-mapped with wildcard port
			// Note: URL normalizes [::ffff:127.0.0.1] to [::ffff:7f00:1]
			test_pattern(
				'http://[::ffff:7f00:1]:*',
				['http://[::ffff:7f00:1]', 'http://[::ffff:7f00:1]:3000', 'http://[::ffff:7f00:1]:8080'],
				['http://[::ffff:7f00:2]:3000', 'https://[::ffff:7f00:1]:3000'],
			);

			// Very long valid IPv6 address (URL may normalize this)
			test_pattern(
				'https://[2001:db8:85a3::8a2e:370:7334]:443',
				['https://[2001:db8:85a3::8a2e:370:7334]:443'],
				['https://[2001:db8:85a3::8a2e:370:7334]'],
			);
		});

		test('handles trailing dots (FQDN)', () => {
			// Trailing dots in hostnames are valid but rarely used
			const patterns = parse_allowed_origins('https://example.com');

			// Trailing dots won't match because we do exact string matching
			assert.ok(!should_allow_origin('https://example.com.', patterns));
			assert.ok(should_allow_origin('https://example.com', patterns));

			// If you want to match trailing dots, you need to include them in the pattern
			const patternsWithDot = parse_allowed_origins('https://example.com.');
			assert.ok(should_allow_origin('https://example.com.', patternsWithDot));
			assert.ok(!should_allow_origin('https://example.com', patternsWithDot));
		});

		test('handles punycode domains', () => {
			// International domain names are converted to punycode
			const patterns = parse_allowed_origins('https://xn--e1afmkfd.xn--p1ai'); // пример.рф in punycode

			assert.ok(should_allow_origin('https://xn--e1afmkfd.xn--p1ai', patterns));
			// The original Unicode domain would need to be converted to punycode before comparison
		});

		test('handles localhost variations', () => {
			const patterns = parse_allowed_origins(
				'http://localhost:*,http://127.0.0.1:*,http://[::1]:*',
			);

			const localhost_origins = [
				'http://localhost',
				'http://localhost:3000',
				'http://127.0.0.1',
				'http://127.0.0.1:8080',
				'http://[::1]',
				'http://[::1]:3000',
			];

			for (const origin of localhost_origins) {
				assert.ok(should_allow_origin(origin, patterns));
			}
		});

		test('handles empty hostname edge case', () => {
			// This should be caught as invalid
			assert.throws(() => parse_allowed_origins('http://:3000'), /Invalid origin pattern/);
		});

		test('handles special regex characters in fixed parts', () => {
			// These characters should be escaped properly
			test_pattern(
				'https://example.com',
				['https://example.com'],
				['https://exampleXcom'], // The dot should not act as a wildcard
			);
		});
	});
});

describe('verify_request_source middleware', () => {
	const allowed_patterns = parse_allowed_origins(
		'http://localhost:3000,https://*.example.com,http://[::1]:3000,https://[2001:db8::1]:*',
	);
	const middleware = verify_request_source(allowed_patterns);

	describe('origin header', () => {
		test('allows matching origins', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://localhost:3000',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://sub.example.com',
			});
		});

		test('allows case-insensitive domain matching', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://LOCALHOST:3000',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://SUB.Example.COM',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://Api.EXAMPLE.com',
			});
		});

		test('blocks non-matching origins', async () => {
			await test_middleware_blocks(
				middleware,
				{
					origin: 'http://evil.com',
				},
				'forbidden_origin',
			);
		});

		test('allows IPv6 origins', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://[::1]:3000',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://[2001:db8::1]',
			});
			await test_middleware_allows(middleware, {
				origin: 'https://[2001:db8::1]:8443',
			});
		});

		test('blocks non-matching IPv6 origins', async () => {
			await test_middleware_blocks(
				middleware,
				{
					origin: 'http://[::1]:8080',
				},
				'forbidden_origin',
			);
			await test_middleware_blocks(
				middleware,
				{
					origin: 'https://[2001:db8::2]:443',
				},
				'forbidden_origin',
			);
		});

		test('prioritizes origin over referer', async () => {
			await test_middleware_allows(middleware, {
				origin: 'http://localhost:3000',
				referer: 'http://evil.com/page',
			});
		});
	});

	describe('referer header', () => {
		test('allows matching referers when no origin', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://localhost:3000/some/page',
			});
		});

		test('allows case-insensitive referer matching', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://LOCALHOST:3000/some/page',
			});
			await test_middleware_allows(middleware, {
				referer: 'https://API.Example.com/endpoint?query=value',
			});
		});

		test('blocks non-matching referers', async () => {
			await test_middleware_blocks(
				middleware,
				{
					referer: 'http://evil.com/page',
				},
				'forbidden_referer',
			);
		});

		test('extracts origin from referer URL', async () => {
			await test_middleware_allows(middleware, {
				referer: 'https://api.example.com/deep/path?query=value#hash',
			});
		});

		test('handles referer with trailing dot', async () => {
			// URL constructor behavior with trailing dots can vary
			// Since we don't normalize, trailing dots won't match patterns without them
			await test_middleware_blocks(
				middleware,
				{
					referer: 'http://localhost.:3000/page',
				},
				'forbidden_referer',
			);

			// Origin header with trailing dot also won't match
			await test_middleware_blocks(
				middleware,
				{
					origin: 'http://localhost.:3000',
				},
				'forbidden_origin',
			);

			// To match trailing dots, you need them in the pattern
			const patternsWithDot = parse_allowed_origins('http://localhost.:3000');
			const middlewareWithDot = verify_request_source(patternsWithDot);

			await test_middleware_allows(middlewareWithDot, {
				referer: 'http://localhost.:3000/page',
			});

			await test_middleware_allows(middlewareWithDot, {
				origin: 'http://localhost.:3000',
			});
		});

		test('allows IPv6 referers', async () => {
			await test_middleware_allows(middleware, {
				referer: 'http://[::1]:3000/some/page',
			});
			await test_middleware_allows(middleware, {
				referer: 'https://[2001:db8::1]:8443/api/endpoint',
			});
		});

		test('blocks non-matching IPv6 referers', async () => {
			await test_middleware_blocks(
				middleware,
				{
					referer: 'http://[::2]:3000/page',
				},
				'forbidden_referer',
			);
		});

		test('blocks invalid referer URLs', async () => {
			await test_middleware_blocks(
				middleware,
				{
					referer: 'not-a-valid-url',
				},
				'forbidden_referer',
			);
		});

		test('blocks referers with null origin (opaque origins)', async () => {
			// data: URLs and sandboxed iframes have origin 'null'
			// new URL('data:text/html,...').origin returns 'null'
			// This should be blocked since 'null' won't match any valid pattern
			await test_middleware_blocks(
				middleware,
				{
					referer: 'data:text/html,<h1>test</h1>',
				},
				'forbidden_referer',
			);
		});
	});

	describe('direct access (no headers)', () => {
		test('allows requests with no origin or referer', async () => {
			await test_middleware_allows(middleware, {});
		});

		test('allows requests with other headers but no origin/referer', async () => {
			await test_middleware_allows(middleware, {
				'user-agent': 'curl/7.64.1',
				accept: '*/*',
			});
		});

		test('allows requests with only sec-fetch-site', async () => {
			await test_middleware_allows(middleware, {
				'sec-fetch-site': 'none',
			});
		});

		test('allows cross-site requests when explicitly allowed by origin', async () => {
			// This is the key difference - sec-fetch-site doesn't block if origin is allowed
			await test_middleware_allows(middleware, {
				'sec-fetch-site': 'cross-site',
				origin: 'http://localhost:3000',
			});
		});
	});

	describe('empty allowed patterns', () => {
		const strict_middleware = verify_request_source([]);

		test('blocks all origin requests', async () => {
			await test_middleware_blocks(
				strict_middleware,
				{
					origin: 'http://localhost:3000',
				},
				'forbidden_origin',
			);
		});

		test('blocks all referer requests', async () => {
			await test_middleware_blocks(
				strict_middleware,
				{
					referer: 'http://localhost:3000/page',
				},
				'forbidden_referer',
			);
		});

		test('still allows direct access (no headers)', async () => {
			await test_middleware_allows(strict_middleware, {});
		});
	});

	describe('header case sensitivity', () => {
		test('headers are case-insensitive', async () => {
			await test_middleware_allows(middleware, {
				Origin: 'http://localhost:3000',
			});
			await test_middleware_allows(middleware, {
				ORIGIN: 'http://localhost:3000',
			});
			await test_middleware_allows(middleware, {
				Referer: 'http://localhost:3000/page',
			});
			await test_middleware_allows(middleware, {
				REFERER: 'http://localhost:3000/page',
			});
		});
	});
});

describe('integration scenarios', () => {
	test('typical development setup', () => {
		const dev_patterns = parse_allowed_origins(
			'http://localhost:3000,http://localhost:5173,http://127.0.0.1:*,http://[::1]:*',
		);
		// Common dev server origins including IPv6
		const dev_origins = [
			'http://localhost:3000',
			'http://localhost:5173',
			'http://127.0.0.1:3000',
			'http://127.0.0.1:8080',
			'http://[::1]:3000',
			'http://[::1]:5173',
			'http://[::1]:8080',
		];

		for (const origin of dev_origins) {
			assert.ok(should_allow_origin(origin, dev_patterns));
		}
	});

	test('production multi-domain setup', () => {
		const prod_patterns = parse_allowed_origins(
			'https://app.example.com,https://*.example.com,https://partner.com',
		);

		const allowed = [
			'https://app.example.com',
			'https://api.example.com',
			'https://staging.example.com',
			'https://partner.com',
		];

		const blocked = [
			'http://app.example.com', // Wrong protocol
			'https://example.com', // No wildcard for base domain
			'https://example.org', // Wrong domain
			'https://sub.partner.com', // No wildcard for partner
			'https://deep.sub.example.com', // Two levels deep
		];

		for (const origin of allowed) {
			assert.ok(should_allow_origin(origin, prod_patterns));
		}

		for (const origin of blocked) {
			assert.ok(!should_allow_origin(origin, prod_patterns));
		}
	});

	test('complex enterprise setup with multiple wildcards', () => {
		test_pattern(
			'https://*.*.corp.example.com:*,https://app.example.com,https://localhost:*',
			[
				'https://api.staging.corp.example.com',
				'https://service.prod.corp.example.com:8443',
				'https://app.example.com',
				'https://localhost:3000',
				'https://localhost',
			],
			[
				'https://staging.corp.example.com', // Only one subdomain level
				'https://api.staging.prod.corp.example.com', // Three subdomain levels
				'http://api.staging.corp.example.com', // Wrong protocol
				'https://app.example.com:443', // Port not allowed in pattern
				'http://localhost:3000', // Wrong protocol
			],
		);
	});

	test('mixed protocols and wildcards', () => {
		const patterns = parse_allowed_origins(
			'http://*.dev.example.com:*,https://*.prod.example.com,https://example.com',
		);

		// HTTP dev with any port
		assert.ok(should_allow_origin('http://api.dev.example.com', patterns));
		assert.ok(should_allow_origin('http://api.dev.example.com:3000', patterns));
		assert.ok(should_allow_origin('http://api.dev.example.com:8080', patterns));

		// HTTPS prod without port flexibility
		assert.ok(should_allow_origin('https://api.prod.example.com', patterns));
		assert.ok(!should_allow_origin('https://api.prod.example.com:443', patterns));

		// Exact match
		assert.ok(should_allow_origin('https://example.com', patterns));

		// Should not match
		assert.ok(!should_allow_origin('https://api.dev.example.com', patterns)); // Wrong protocol
		assert.ok(!should_allow_origin('http://api.prod.example.com', patterns)); // Wrong protocol
		assert.ok(!should_allow_origin('https://sub.example.com', patterns)); // No wildcard
	});
});

describe('normalize_origin', () => {
	test('handles explicit default port 443 for HTTPS', () => {
		const patterns = parse_allowed_origins('https://example.com:443');

		// The pattern explicitly includes :443
		assert.ok(should_allow_origin('https://example.com:443', patterns));
		// Without the port, it won't match (we don't normalize)
		assert.ok(!should_allow_origin('https://example.com', patterns));
	});

	test('handles explicit default port 80 for HTTP', () => {
		const patterns = parse_allowed_origins('http://example.com:80');

		// The pattern explicitly includes :80
		assert.ok(should_allow_origin('http://example.com:80', patterns));
		// Without the port, it won't match (we don't normalize)
		assert.ok(!should_allow_origin('http://example.com', patterns));
	});

	test('preserves non-standard ports', () => {
		const patterns = parse_allowed_origins('https://example.com:8443');

		assert.ok(should_allow_origin('https://example.com:8443', patterns));
		assert.ok(!should_allow_origin('https://example.com', patterns));
	});
});

import {describe, test, assert} from 'vitest';

import {load_server_env} from '../../lib/server/server_env.js';

describe('load_server_env', () => {
	const empty_env = () => undefined;

	test('defaults allowed_origins to http://localhost:*', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.allowed_origins, 'http://localhost:*');
	});

	test('respects ALLOWED_ORIGINS from env', () => {
		const env = load_server_env((key) =>
			key === 'ALLOWED_ORIGINS' ? 'https://example.com' : undefined,
		);
		assert.strictEqual(env.allowed_origins, 'https://example.com');
	});

	test('respects allowed_origins from defaults', () => {
		const env = load_server_env(empty_env, {allowed_origins: 'http://custom:*'});
		assert.strictEqual(env.allowed_origins, 'http://custom:*');
	});

	test('defaults host to localhost', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.host, 'localhost');
	});

	test('defaults port to 4460', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.port, 4460);
	});

	test('reads host from PUBLIC_SERVER_HOST', () => {
		const env = load_server_env((key) => (key === 'PUBLIC_SERVER_HOST' ? '127.0.0.1' : undefined));
		assert.strictEqual(env.host, '127.0.0.1');
	});

	test('reads port from PUBLIC_SERVER_PROXIED_PORT', () => {
		const env = load_server_env((key) =>
			key === 'PUBLIC_SERVER_PROXIED_PORT' ? '9999' : undefined,
		);
		assert.strictEqual(env.port, 9999);
	});

	test('empty string ALLOWED_ORIGINS falls through to default', () => {
		const env = load_server_env((key) => (key === 'ALLOWED_ORIGINS' ? '' : undefined));
		assert.strictEqual(env.allowed_origins, 'http://localhost:*');
	});

	test('env takes priority over defaults', () => {
		const env = load_server_env((key) => (key === 'ALLOWED_ORIGINS' ? 'http://env:*' : undefined), {
			allowed_origins: 'http://default:*',
		});
		assert.strictEqual(env.allowed_origins, 'http://env:*');
	});

	test('defaults take priority over fallback', () => {
		const env = load_server_env(empty_env, {allowed_origins: 'http://default:*'});
		assert.strictEqual(env.allowed_origins, 'http://default:*');
	});

	test('invalid port string falls through to default', () => {
		const env = load_server_env((key) =>
			key === 'PUBLIC_SERVER_PROXIED_PORT' ? 'notanumber' : undefined,
		);
		assert.strictEqual(env.port, 4460);
	});
});

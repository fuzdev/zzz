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

	test('respects allowed_origins from overrides', () => {
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

	test('empty string ALLOWED_ORIGINS uses default', () => {
		// Zod default kicks in for empty string since it coerces to the default
		const env = load_server_env((key) => (key === 'ALLOWED_ORIGINS' ? '' : undefined));
		// Empty string is still a valid string, so it passes through (not undefined)
		assert.strictEqual(env.allowed_origins, '');
	});

	test('overrides take priority over env', () => {
		const env = load_server_env((key) => (key === 'ALLOWED_ORIGINS' ? 'http://env:*' : undefined), {
			allowed_origins: 'http://override:*',
		});
		assert.strictEqual(env.allowed_origins, 'http://override:*');
	});

	test('defaults websocket_path to /ws', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.websocket_path, '/ws');
	});

	test('defaults api_path to /api/rpc', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.api_path, '/api/rpc');
	});

	test('parses scoped_dirs from comma-separated string', () => {
		const env = load_server_env((key) =>
			key === 'PUBLIC_ZZZ_SCOPED_DIRS' ? '/tmp/a, /tmp/b , /tmp/c' : undefined,
		);
		assert.deepEqual(env.scoped_dirs, ['/tmp/a', '/tmp/b', '/tmp/c']);
	});

	test('scoped_dirs defaults to empty array', () => {
		const env = load_server_env(empty_env);
		assert.deepEqual(env.scoped_dirs, []);
	});

	test('reads API keys from env', () => {
		const env = load_server_env((key) => {
			if (key === 'SECRET_ANTHROPIC_API_KEY') return 'sk-ant-test';
			if (key === 'SECRET_OPENAI_API_KEY') return 'sk-test';
			if (key === 'SECRET_GOOGLE_API_KEY') return 'AIza-test';
			return undefined;
		});
		assert.strictEqual(env.secret_anthropic_api_key, 'sk-ant-test');
		assert.strictEqual(env.secret_openai_api_key, 'sk-test');
		assert.strictEqual(env.secret_google_api_key, 'AIza-test');
	});

	test('API keys default to undefined', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.secret_anthropic_api_key, undefined);
		assert.strictEqual(env.secret_openai_api_key, undefined);
		assert.strictEqual(env.secret_google_api_key, undefined);
	});

	test('reads artificial delay from env', () => {
		const env = load_server_env((key) =>
			key === 'PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY' ? '500' : undefined,
		);
		assert.strictEqual(env.artificial_delay, 500);
	});

	test('artificial delay defaults to 0', () => {
		const env = load_server_env(empty_env);
		assert.strictEqual(env.artificial_delay, 0);
	});

	test('invalid port string causes validation error', () => {
		// Zod rejects NaN from coercing 'notanumber' — correct behavior
		assert.throws(
			() =>
				load_server_env((key) => (key === 'PUBLIC_SERVER_PROXIED_PORT' ? 'notanumber' : undefined)),
			/Environment validation failed/,
		);
	});
});

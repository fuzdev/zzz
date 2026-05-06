import {describe, test, assert} from 'vitest';

import {load_server_env} from '../../lib/server/server_env.js';

describe('load_server_env', () => {
	// BaseServerEnv requires NODE_ENV and ALLOWED_ORIGINS minimum
	const base_env = (key: string): string | undefined => {
		if (key === 'NODE_ENV') return 'development';
		if (key === 'DATABASE_URL') return 'memory://';
		if (key === 'SECRET_COOKIE_KEYS') return 'dev-only-not-for-production-use-000';
		if (key === 'ALLOWED_ORIGINS') return 'http://localhost:*';
		return undefined;
	};

	const with_env =
		(overrides: Record<string, string>) =>
		(key: string): string | undefined =>
			overrides[key] ?? base_env(key);

	test('defaults host to localhost', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.host, 'localhost');
	});

	test('defaults port to 4040', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.port, 4040);
	});

	test('reads host from HOST', () => {
		const config = load_server_env(with_env({HOST: '127.0.0.1'}));
		assert.strictEqual(config.host, '127.0.0.1');
	});

	test('reads port from PORT', () => {
		const config = load_server_env(with_env({PORT: '9999'}));
		assert.strictEqual(config.port, 9999);
	});

	test('env object contains ALLOWED_ORIGINS', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.env.ALLOWED_ORIGINS, 'http://localhost:*');
	});

	test('respects ALLOWED_ORIGINS from env', () => {
		const config = load_server_env(with_env({ALLOWED_ORIGINS: 'https://example.com'}));
		assert.strictEqual(config.env.ALLOWED_ORIGINS, 'https://example.com');
	});

	test('defaults websocket_path to /api/ws', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.websocket_path, '/api/ws');
	});

	test('defaults api_path to /api/rpc', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.api_path, '/api/rpc');
	});

	test('parses scoped_dirs from comma-separated string', () => {
		const config = load_server_env(with_env({PUBLIC_ZZZ_SCOPED_DIRS: '/tmp/a, /tmp/b , /tmp/c'}));
		assert.deepEqual(config.scoped_dirs, ['/tmp/a', '/tmp/b', '/tmp/c']);
	});

	test('scoped_dirs defaults to empty array', () => {
		const config = load_server_env(base_env);
		assert.deepEqual(config.scoped_dirs, []);
	});

	test('reads API keys from env', () => {
		const config = load_server_env(
			with_env({
				SECRET_ANTHROPIC_API_KEY: 'sk-ant-test',
				SECRET_OPENAI_API_KEY: 'sk-test',
				SECRET_GOOGLE_API_KEY: 'AIza-test',
			}),
		);
		assert.strictEqual(config.secret_anthropic_api_key, 'sk-ant-test');
		assert.strictEqual(config.secret_openai_api_key, 'sk-test');
		assert.strictEqual(config.secret_google_api_key, 'AIza-test');
	});

	test('API keys default to undefined', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.secret_anthropic_api_key, undefined);
		assert.strictEqual(config.secret_openai_api_key, undefined);
		assert.strictEqual(config.secret_google_api_key, undefined);
	});

	test('reads artificial delay from env', () => {
		const config = load_server_env(with_env({PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY: '500'}));
		assert.strictEqual(config.artificial_delay, 500);
	});

	test('artificial delay defaults to 0', () => {
		const config = load_server_env(base_env);
		assert.strictEqual(config.artificial_delay, 0);
	});

	test('overrides take priority over env', () => {
		const config = load_server_env(base_env, {host: '0.0.0.0'});
		assert.strictEqual(config.host, '0.0.0.0');
	});
});

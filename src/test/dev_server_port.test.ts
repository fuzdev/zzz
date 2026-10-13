import { test, assert, describe } from 'vitest';

import {
	check_dev_server_port,
	DEV_SERVER_PORT_VAR,
	type DevServerPortOptions
} from '#lib/dev_server_port.ts';

const options = (overrides: Partial<DevServerPortOptions>): DevServerPortOptions => ({
	loaded: '5460',
	port: 5460,
	from_process_env: false,
	mode: 'development',
	...overrides
});

describe('check_dev_server_port', () => {
	test('the port being served passes', () => {
		assert.strictEqual(check_dev_server_port(options({})), null);
		// the value `cargo xtask dev` forces into the process environment
		assert.strictEqual(check_dev_server_port(options({ from_process_env: true })), null);
		assert.strictEqual(check_dev_server_port(options({ loaded: '5999', port: 5999 })), null);
	});

	test("unset or blank passes: the UI calls the page's own origin", () => {
		for (const loaded of [undefined, '', '  ']) {
			assert.strictEqual(check_dev_server_port(options({ loaded })), null, String(loaded));
		}
	});

	test('another port fails, naming the variable, both values, and the line to set', () => {
		for (const loaded of ['5173', '4461', '54600', '546', '05460', ' 5460', 'abc']) {
			const message = check_dev_server_port(options({ loaded }));
			assert.ok(message, loaded);
			assert.include(message, `${DEV_SERVER_PORT_VAR} is \`${loaded}\``);
			assert.include(message, 'serves on port 5460');
			assert.include(message, '`.env.development`');
			assert.ok(message.endsWith('\n  PUBLIC_ZZZ_SERVER_PORT=5460'), message);
		}
	});

	test('the expected value follows the port being served', () => {
		const message = check_dev_server_port(options({ loaded: '5460', port: 5999 }));
		assert.ok(message);
		assert.include(message, 'serves on port 5999');
		assert.ok(message.endsWith('\n  PUBLIC_ZZZ_SERVER_PORT=5999'), message);
	});

	test('the message says where the value came from', () => {
		const from_file = check_dev_server_port(options({ loaded: '5173', mode: 'staging' }));
		assert.ok(from_file);
		assert.include(from_file, 'from an env file, `.env.staging`');
		assert.include(from_file, 'Change the line in `.env.staging`');
		assert.notInclude(from_file, 'process environment');

		const from_env = check_dev_server_port(options({ loaded: '5173', from_process_env: true }));
		assert.ok(from_env);
		assert.include(from_env, 'from the process environment');
		assert.include(from_env, 'Unset it, or export this value');
		assert.notInclude(from_env, '.env.development');
	});
});

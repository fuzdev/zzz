/**
 * Login / password rate-limit integration tests.
 *
 * Rust-only — exercises the per-IP sliding-window limiter behind
 * `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1`. fuz_app's TS port has its own rate
 * limiter wired through `app_server.ts` with different orchestration;
 * cross-backend parity for the 429 wire shape isn't the goal of this
 * phase. The runner launches a dedicated Rust backend instance with the
 * env var on for this suite so the rest of the test run keeps the
 * limiter off (default — existing failed-login tests would otherwise
 * burn the bucket).
 *
 * Skipping on Deno mirrors the precedent set by
 * `bearer_rejects_account_token_create_ws` (Rust-only test, `skip:
 * ['deno']`) in `bearer_tests.ts`.
 */

import {type BackendConfig} from './config.ts';
import {assert_equal} from './test_helpers.ts';
import type {TestResult} from './tests.ts';

interface LoginErrorBody {
	error: string;
	retry_after?: number;
}

const post_login = async (
	config: BackendConfig,
	body: {username: string; password: string},
): Promise<{status: number; body: LoginErrorBody; retry_after_header: string | null}> => {
	const paths = config.account_paths;
	if (!paths) throw new Error('account_paths not configured');
	const res = await fetch(`${config.base_url}${paths.login}`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as LoginErrorBody;
	return {
		status: res.status,
		body: json,
		retry_after_header: res.headers.get('retry-after'),
	};
};

type TestFn = (config: BackendConfig) => Promise<void>;

const rate_limit_test_list: ReadonlyArray<{
	name: string;
	fn: TestFn;
	skip?: readonly string[];
}> = [
	{
		// 5 attempts per 15 min per-IP is the fuz_app default ported to
		// Rust. Six failed logins from the same IP — the 6th must return
		// 429 with `retry_after` and a `Retry-After` header.
		name: 'rate_limit_login_blocks_after_threshold',
		skip: ['deno'],
		fn: async (config) => {
			// Burn through the 5-attempt budget with a deliberately-wrong
			// password. The bootstrapped admin account exists, so this hits
			// the "found account, wrong password" path that records the
			// failure on both rate limiters.
			for (let i = 0; i < 5; i++) {
				const res = await post_login(config, {
					username: config.auth!.username,
					password: 'rate-limit-test-wrong-pw',
				});
				assert_equal(res.status, 401, `attempt ${i + 1} → 401`);
			}

			// 6th failed login should trip the per-IP limiter and return 429
			// without doing any argon2 work.
			const blocked = await post_login(config, {
				username: config.auth!.username,
				password: 'rate-limit-test-wrong-pw',
			});
			assert_equal(blocked.status, 429, '6th attempt → 429');
			assert_equal(blocked.body.error, 'rate_limit_exceeded', 'error code');
			assert_equal(
				typeof blocked.body.retry_after,
				'number',
				'retry_after is a number',
			);
			if (!blocked.body.retry_after || blocked.body.retry_after <= 0) {
				throw new Error(`retry_after should be positive, got ${blocked.body.retry_after}`);
			}
			assert_equal(
				typeof blocked.retry_after_header,
				'string',
				'Retry-After header present',
			);

			// Correct credentials should also be blocked while the bucket
			// is full — the limiter check runs before the password verify.
			const correct = await post_login(config, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(correct.status, 429, 'correct credentials also 429');
		},
	},
];

export const run_rate_limit_tests = async (
	config: BackendConfig,
	filter?: string,
): Promise<TestResult[]> => {
	const results: TestResult[] = [];

	if (!config.account_paths) {
		return results;
	}

	for (const test of rate_limit_test_list) {
		if (filter && !test.name.includes(filter)) continue;
		if (test.skip?.includes(config.name)) continue;
		const start = performance.now();
		try {
			await test.fn(config);
			results.push({name: test.name, passed: true, duration_ms: performance.now() - start});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			results.push({
				name: test.name,
				passed: false,
				duration_ms: performance.now() - start,
				error: message,
			});
		}
	}

	return results;
};

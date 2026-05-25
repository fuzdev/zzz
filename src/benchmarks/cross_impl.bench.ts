/**
 * Cross-impl latency benchmark — TS (deno + node) vs Rust spine, apples-to-apples
 * over real HTTP. Spawns all three zzz backends at once, runs identical RPC
 * round-trip scenarios against each, prints a per-scenario markdown table + the
 * TS-vs-Rust significance verdict, and writes a JSON artifact.
 *
 * The reusable cross-impl measurement primitive lives in fuz_app
 * (`@fuzdev/fuz_app/testing/cross_backend/bench/`); this script is zzz's
 * wiring of it across its three cross-process backends.
 *
 * Run: `npm run benchmark:cross-impl` (or `gro run src/benchmarks/cross_impl.bench.ts`).
 *
 * Prereqs (same as the cross-backend test suites):
 * - the Rust binary builds (`cargo build --release --bin testing_zzz_server` runs as part of spawn)
 * - the Rust test DB exists: `createdb zzz_test_rust 2>/dev/null || true`
 *
 * @module
 */

import {writeFileSync} from 'node:fs';

import {bootstrap_backend} from '@fuzdev/fuz_app/testing/cross_backend/bootstrap_backend.js';
import type {BootstrappedBackendHandle} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {run_cross_impl_bench} from '@fuzdev/fuz_app/testing/cross_backend/bench/run_cross_impl_bench.js';
import {default_bench_scenarios} from '@fuzdev/fuz_app/testing/cross_backend/bench/scenario.js';
import {
	compare_cross_impl,
	format_cross_impl_comparison,
	format_cross_impl_json,
	format_cross_impl_markdown,
} from '@fuzdev/fuz_app/testing/cross_backend/bench/bench_report.js';

import {
	deno_backend_config,
	node_backend_config,
	rust_backend_config,
} from '../test/cross_backend/zzz_backend_config.js';

const ARTIFACT_PATH = 'src/benchmarks/cross_impl.latest.json';

const configs = [deno_backend_config(), node_backend_config(), rust_backend_config()];

const handles: Array<BootstrappedBackendHandle> = [];
try {
	// Spawn + bootstrap every backend up front so they're all alive for the run.
	// Sequential on purpose — parallel spawns would contend during boot.
	for (const config of configs) {
		handles.push(await bootstrap_backend(config));
	}

	const result = await run_cross_impl_bench({handles, scenarios: default_bench_scenarios});

	console.log(`\n${format_cross_impl_markdown(result)}\n`);
	// Compare each impl against the deno TS reference.
	console.log(format_cross_impl_comparison(compare_cross_impl(result, {reference: 'deno'})));

	writeFileSync(ARTIFACT_PATH, `${format_cross_impl_json(result)}\n`);
	console.log(`\nwrote ${ARTIFACT_PATH}`);
} finally {
	await Promise.allSettled(handles.map((h) => h.teardown()));
}

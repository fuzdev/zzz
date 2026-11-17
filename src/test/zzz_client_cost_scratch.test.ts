// @vitest-environment jsdom
// scratch — copied into src/test for one run, then removed
import { readFileSync, appendFileSync } from 'node:fs';
import { test, vi } from 'vitest';
import { run_bench } from '/home/desk/.cache/zzz-repos/client_cost/bench.ts';

const OUT = '/home/desk/.cache/zzz-repos/measure/out';
const LOG = process.env.BENCH_LOG ?? '/home/desk/.cache/zzz-repos/client_cost/vitest.log';
const TREES = (process.env.MEASURE_TREES ?? 'typescript').split(',');

for (const name of TREES) {
	test(`client cost breakdown: ${name}`, { timeout: 600_000 }, async () => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		const text = readFileSync(`${OUT}/${name}_git_repo_focus.json`, 'utf8');
		await run_bench(name, text, {
			log: (l) => { appendFileSync(LOG, l + '\n'); process.stdout.write(l + '\n'); },
			heap: () => process.memoryUsage().heapUsed,
			gc: () => (globalThis as any).gc?.(),
			tick: () => new Promise((r) => setTimeout(r, 0))
		});
	});
}

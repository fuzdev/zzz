import { test, describe, assert } from 'vitest';

import {
	create_fuz_terminal_module_loader,
	fetch_fuz_terminal_module,
	FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS,
	type FuzTerminalModuleDeps
} from '#lib/fuz_terminal_module.ts';

import {
	create_manual_timers,
	type ManualTimers
} from './fuz_terminal/fuz_terminal_test_helpers.ts';

/** The smallest valid wasm module: the magic number and version 1. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const URL = '/fuz_terminal/ghostty-vt.wasm';

interface TestDeps extends FuzTerminalModuleDeps {
	fetched: Array<string>;
	compiled: Array<'streaming' | 'bytes'>;
	/** The signal each fetch was given. */
	signals: Array<AbortSignal>;
	timers: ManualTimers;
}

/** Deps whose `fetch` answers with `respond()`, and that record each fetch and compile. */
const create_deps = (respond: () => Response | Promise<Response>, streaming = true): TestDeps => {
	const fetched: Array<string> = [];
	const compiled: Array<'streaming' | 'bytes'> = [];
	const signals: Array<AbortSignal> = [];
	const timers = create_manual_timers();
	return {
		url: URL,
		fetched,
		compiled,
		signals,
		timers,
		set_timeout: timers.set_timeout,
		clear_timeout: (id) => timers.clear_timeout(id as number),
		fetch: async (url, { signal }) => {
			fetched.push(url);
			signals.push(signal);
			return respond();
		},
		compile_streaming: streaming
			? async (response) => {
					compiled.push('streaming');
					return WebAssembly.compile(await response.arrayBuffer());
				}
			: undefined,
		compile: (bytes) => {
			compiled.push('bytes');
			return WebAssembly.compile(bytes);
		}
	};
};

const wasm_response = (content_type: string | null = 'application/wasm'): Response =>
	new Response(EMPTY_MODULE, {
		headers: content_type === null ? {} : { 'content-type': content_type }
	});

const assert_rejects_with = async (promise: Promise<unknown>, pattern: RegExp): Promise<Error> => {
	try {
		await promise;
	} catch (error) {
		assert(error instanceof Error);
		assert.match(error.message, pattern);
		return error;
	}
	assert.fail('expected a rejection');
};

describe('fetch_fuz_terminal_module', () => {
	test('compiles streaming when served as application/wasm', async () => {
		const deps = create_deps(() => wasm_response('application/wasm; charset=binary'));
		const module = await fetch_fuz_terminal_module(deps);
		assert(module instanceof WebAssembly.Module);
		assert.deepEqual(deps.fetched, [URL]);
		assert.deepEqual(deps.compiled, ['streaming']);
	});

	test('compiles the bytes when served as another type, or with no streaming compile', async () => {
		for (const content_type of ['application/octet-stream', null]) {
			const deps = create_deps(() => wasm_response(content_type));
			assert(
				(await fetch_fuz_terminal_module(deps)) instanceof WebAssembly.Module,
				`${content_type}`
			);
			assert.deepEqual(deps.compiled, ['bytes'], `${content_type}`);
		}
		const deps = create_deps(() => wasm_response(), false);
		assert((await fetch_fuz_terminal_module(deps)) instanceof WebAssembly.Module);
		assert.deepEqual(deps.compiled, ['bytes']);
	});

	test('a 404 says the module needs building', async () => {
		const deps = create_deps(() => new Response('', { status: 404 }));
		const error = await assert_rejects_with(
			fetch_fuz_terminal_module(deps),
			/isn't available .*answered 404.*cargo xtask ghostty-vt/
		);
		assert.include(error.message, URL);
		assert.deepEqual(deps.compiled, []);
	});

	test('an HTML page in place of the module says the module needs building', async () => {
		const deps = create_deps(
			() =>
				new Response('<!doctype html><title>zzz</title>', {
					headers: { 'content-type': 'text/html' }
				})
		);
		await assert_rejects_with(
			fetch_fuz_terminal_module(deps),
			/isn't a wasm module: it's text\/html.*cargo xtask ghostty-vt/
		);
		assert.deepEqual(deps.compiled, []);
	});

	test('a failed fetch names the module', async () => {
		const deps = create_deps(() => {
			throw new TypeError('network down');
		});
		await assert_rejects_with(fetch_fuz_terminal_module(deps), /couldn't fetch .*network down/);
	});
});

describe('create_fuz_terminal_module_loader', () => {
	test('one fetch and one module for every caller', async () => {
		const deps = create_deps(() => wasm_response());
		const load = create_fuz_terminal_module_loader(() => deps);
		const first = load();
		const second = load();
		assert.strictEqual(first, second, 'callers during the load share it');
		const module = await first;
		assert.strictEqual(await load(), module, 'callers after it get the same module');
		assert.deepEqual(deps.fetched, [URL]);
	});

	test('a failed load is retried by the next caller', async () => {
		let missing = true;
		const deps = create_deps(() => (missing ? new Response('', { status: 404 }) : wasm_response()));
		const load = create_fuz_terminal_module_loader(() => deps);
		const first = load();
		const during = load();
		assert.strictEqual(first, during, 'callers during the failing load share its failure');
		await assert_rejects_with(first, /404/);
		await assert_rejects_with(load(), /404/);
		assert.strictEqual(deps.fetched.length, 2, 'each load after a failure fetches again');
		missing = false;
		const module = await load();
		assert(module instanceof WebAssembly.Module);
		assert.strictEqual(await load(), module, 'a success is kept');
		assert.strictEqual(deps.fetched.length, 3);
	});
});

/** A response that never comes. */
const never = (): Promise<Response> => new Promise(() => {});

describe('the load timeout', () => {
	test('a load that settles in time is unaffected, its timer cleared', async () => {
		const deps = create_deps(() => wasm_response());
		assert((await fetch_fuz_terminal_module(deps)) instanceof WebAssembly.Module);
		assert.strictEqual(deps.timers.pending, 0);
		assert.isFalse(deps.signals[0]!.aborted);
		// a failure in time clears it too
		const missing = create_deps(() => new Response('', { status: 404 }));
		await assert_rejects_with(fetch_fuz_terminal_module(missing), /404/);
		assert.strictEqual(missing.timers.pending, 0);
	});

	test('a load that never settles fails at the bound, aborting the fetch', async () => {
		const deps = create_deps(never);
		const load = fetch_fuz_terminal_module(deps);
		await Promise.resolve();
		deps.timers.advance(FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS - 1);
		deps.timers.advance(1);
		const error = await assert_rejects_with(
			load,
			/didn't load within 30s .*cargo xtask ghostty-vt/
		);
		assert.include(error.message, URL);
		assert.isTrue(deps.signals[0]!.aborted);
	});

	test('the bound covers the compile too, and a late result is dropped', async () => {
		let finish!: (module: WebAssembly.Module) => void;
		const deps = {
			...create_deps(() => wasm_response()),
			compile_streaming: () => new Promise<WebAssembly.Module>((resolve) => (finish = resolve))
		};
		const load = fetch_fuz_terminal_module({ ...deps, timeout_ms: 1000 });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		deps.timers.advance(1000);
		await assert_rejects_with(load, /didn't load within 1s/);
		finish(await WebAssembly.compile(EMPTY_MODULE));
	});

	test('callers sharing a timed-out load fail together, and the next call starts fresh', async () => {
		let hang = true;
		const deps = create_deps(() => (hang ? never() : wasm_response()));
		const load = create_fuz_terminal_module_loader(() => deps);
		const first = load();
		const second = load();
		assert.strictEqual(first, second);
		await Promise.resolve();
		deps.timers.advance(FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS);
		await assert_rejects_with(first, /didn't load within/);
		await assert_rejects_with(second, /didn't load within/);
		hang = false;
		assert((await load()) instanceof WebAssembly.Module, 'a retry loads');
		assert.strictEqual(deps.fetched.length, 2);
	});
});

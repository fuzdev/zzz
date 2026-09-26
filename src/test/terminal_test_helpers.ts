import type { Frontend } from '$lib/frontend.svelte.ts';

/** A stubbed terminal RPC call, settled manually by the test. */
export interface StubbedTerminalCall {
	method: string;
	input: any;
	resolve: (result: unknown) => void;
}

export const TERMINAL_API_METHODS = [
	'terminal_create',
	'terminal_data_send',
	'terminal_resize',
	'terminal_close'
] as const;

/**
 * Replaces `app.api` with stubs for the terminal methods that stay in flight
 * until the test resolves them with `result_ok` / `result_error`.
 *
 * @returns the calls, in order
 */
export const stub_terminal_api = (app: Frontend): Array<StubbedTerminalCall> => {
	const calls: Array<StubbedTerminalCall> = [];
	const api: Record<string, (input: unknown) => Promise<unknown>> = {};
	for (const method of TERMINAL_API_METHODS) {
		api[method] = (input) =>
			new Promise((resolve) => {
				calls.push({ method, input, resolve });
			});
	}
	(app as unknown as { api: unknown }).api = api;
	return calls;
};

export const result_ok = (value: unknown = null): unknown => ({ ok: true, value });

export const result_error = (code: number, message: string): unknown => ({
	ok: false,
	error: { code, message }
});

/** Lets pending promise continuations run. */
export const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
};

export const calls_of = (
	calls: Array<StubbedTerminalCall>,
	method: string
): Array<StubbedTerminalCall> => calls.filter((c) => c.method === method);

/**
 * The env var the dev UI builds its absolute server URL from
 * (`SERVER_URL` in `constants.ts`).
 */
export const DEV_SERVER_PORT_VAR = 'PUBLIC_ZZZ_SERVER_PORT';

export interface DevServerPortOptions {
	/** The value of `DEV_SERVER_PORT_VAR` as Vite loaded it, `undefined` when unset. */
	loaded: string | undefined;
	/** The port the dev server is about to serve on. */
	port: number;
	/** Whether the loaded value came from the process environment rather than an env file. */
	from_process_env: boolean;
	/** The Vite mode, which names the env file (`.env.<mode>`). */
	mode: string;
}

/**
 * Checks that the dev UI calls the dev server that serves it.
 *
 * The UI sends its HTTP RPC calls and file bytes to
 * `http://localhost:<PUBLIC_ZZZ_SERVER_PORT>` when the variable is set, so a
 * value naming another port sends them to whatever process listens there.
 * Login and the WebSocket don't use the variable and keep working, which
 * makes the misroute easy to miss — so the dev server refuses to start.
 * Unset or blank is fine: the UI then calls the page's own origin.
 *
 * `vite.config.ts` runs this when the dev server starts.
 *
 * @returns the error to fail the dev server with, or `null` when the value is consistent
 */
export const check_dev_server_port = (options: DevServerPortOptions): string | null => {
	const { loaded, port, from_process_env, mode } = options;
	if (loaded === undefined || loaded.trim() === '') return null;
	const expected = String(port);
	if (loaded === expected) return null;
	const source = from_process_env
		? 'the process environment'
		: `an env file, \`.env.${mode}\` or another \`.env*\` file Vite loads in ${mode} mode`;
	const fix = from_process_env
		? `Unset it, or export this value, then start the dev server again:`
		: `Change the line in \`.env.${mode}\`, then start the dev server again:`;
	return (
		`${DEV_SERVER_PORT_VAR} is \`${loaded}\` (from ${source}), but this dev server serves on port ${expected}.\n` +
		`The UI builds its server URL from that variable, so its RPC calls, uploads, and downloads ` +
		`would go to whatever listens on port ${loaded}, not to this dev server.\n` +
		`${fix}\n` +
		`  ${DEV_SERVER_PORT_VAR}=${expected}`
	);
};

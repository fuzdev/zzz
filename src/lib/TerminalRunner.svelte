<script lang="ts">
	import {slide} from 'svelte/transition';

	import {app_context} from './app.svelte.js';
	import type {Uuid} from './zod_helpers.js';
	import {TerminalPreset} from './terminal_preset.svelte.js';
	import TerminalRunItem from './TerminalRunItem.svelte';
	import TerminalPresetBar from './TerminalPresetBar.svelte';
	import TerminalCommandInput from './TerminalCommandInput.svelte';
	import {Scrollable} from './scrollable.svelte.js';

	const app = app_context.get();

	interface RunEntry {
		terminal_id: Uuid;
		command: string;
		args: Array<string>;
	}

	const runs: Array<RunEntry> = $state([]);
	let error_message: string | null = $state.raw(null);

	const scrollable = new Scrollable();

	const default_preset_configs = [
		{name: 'echo hello world', command: 'echo', args: ['hello', 'world']},
		{name: 'check', command: 'gro', args: ['check']},
		{name: 'build', command: 'gro', args: ['build']},
		{name: 'dev', command: 'gro', args: ['dev']},
	];

	// Seed preset Cell instances from defaults
	const presets: Array<TerminalPreset> = $state(
		default_preset_configs.map(
			(p) => new TerminalPreset({app, json: {name: p.name, command: p.command, args: p.args}}),
		),
	);

	const format_command = (command: string, args: Array<string>): string =>
		args.length ? `${command} ${args.join(' ')}` : command;

	// Spawn a shell session so the terminal stays alive for follow-up commands,
	// then send `input` followed by a newline to run it.
	const spawn_and_run = async (
		input: string,
	): Promise<{ok: true; terminal_id: Uuid} | {ok: false; error: string}> => {
		const result = await app.api.terminal_create({command: 'sh', args: []});
		if (!result.ok) return {ok: false, error: result.error.message};
		const {terminal_id} = result.value;
		void app.api.terminal_data_send({terminal_id, data: input + '\n'});
		return {ok: true, terminal_id};
	};

	const create_terminal = async (command: string, args: Array<string>): Promise<void> => {
		error_message = null;
		const input = format_command(command, args);
		const result = await spawn_and_run(input);
		if (result.ok) {
			runs.push({terminal_id: result.terminal_id, command, args});
		} else {
			error_message = `failed to run "${input}": ${result.error}`;
		}
	};

	const handle_send = (command_text: string): void => {
		const trimmed = command_text.trim();
		if (!trimmed) return;
		const [command, ...args] = trimmed.split(/\s+/);
		if (!command) return;
		void create_terminal(command, args);
	};

	const handle_preset = (preset: TerminalPreset): void => {
		void create_terminal(preset.command, preset.args);
	};

	const handle_preset_create = (name: string, command: string, args: Array<string>): void => {
		presets.push(new TerminalPreset({app, json: {name, command, args}}));
	};

	const handle_preset_delete = (preset: TerminalPreset): void => {
		const index = presets.indexOf(preset);
		if (index !== -1) presets.splice(index, 1);
	};

	const handle_close =
		(_terminal_id: Uuid) =>
		(_exit_code: number | null): void => {
			// keep in history — don't remove
		};

	const handle_restart = (run: RunEntry) => async (): Promise<void> => {
		// close may fail if the terminal already exited — ignore
		await app.api.terminal_close({terminal_id: run.terminal_id}).catch(() => undefined);
		const result = await spawn_and_run(format_command(run.command, run.args));
		if (result.ok) {
			const index = runs.indexOf(run);
			if (index !== -1) {
				runs[index] = {terminal_id: result.terminal_id, command: run.command, args: run.args};
			}
		}
	};
</script>

<div class="terminal-runner">
	<div class="run-history" {@attach scrollable.container} {@attach scrollable.target}>
		<div class="run-list">
			{#each runs as run (run.terminal_id)}
				<div transition:slide>
					<TerminalRunItem
						terminal_id={run.terminal_id}
						command={run.command}
						args={run.args}
						onclose={handle_close(run.terminal_id)}
						onrestart={handle_restart(run)}
					/>
				</div>
			{/each}
		</div>
	</div>

	{#if runs.length === 0}
		<p class="empty-state">no commands run yet — use a preset or type a command below</p>
	{/if}

	{#if error_message}
		<p class="error-message">{error_message}</p>
	{/if}

	<div class="input-area">
		<TerminalPresetBar
			{presets}
			onrun={handle_preset}
			oncreate={handle_preset_create}
			ondelete={handle_preset_delete}
		/>
		<TerminalCommandInput onsend={handle_send} />
	</div>
</div>

<style>
	.terminal-runner {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.run-history {
		flex: 1;
		overflow: auto;
		scrollbar-width: thin;
		display: flex;
		flex-direction: column-reverse;
	}
	.run-list {
		display: flex;
		flex-direction: column;
		gap: var(--space_md);
		padding: var(--space_md);
	}
	.empty-state {
		opacity: 0.5;
		text-align: center;
		padding: var(--space_xl);
	}
	.error-message {
		color: var(--color_c_50, #f88);
		padding: 0 var(--space_md);
		margin: 0;
	}
	.input-area {
		display: flex;
		flex-direction: column;
		gap: var(--space_sm);
		padding: var(--space_md);
		border-top: 1px solid var(--border_color, #333);
	}
</style>

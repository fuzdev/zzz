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
	let error_message: string | null = $state(null);

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

	const create_terminal = async (command: string, args: Array<string>): Promise<void> => {
		error_message = null;
		const result = await app.api.terminal_create({command, args});
		if (result.ok && result.value?.terminal_id) {
			runs.push({
				terminal_id: result.value.terminal_id,
				command,
				args,
			});
		} else {
			const msg = result.ok ? 'unknown error' : (result.error?.message ?? 'unknown error');
			error_message = `failed to run "${command}${args.length ? ' ' + args.join(' ') : ''}": ${msg}`;
		}
	};

	const handle_send = (command_text: string): void => {
		const [command, ...args] = command_text.split(/\s+/);
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
		const result = await app.api.terminal_create({command: run.command, args: run.args});
		if (result.ok && result.value?.terminal_id) {
			const index = runs.indexOf(run);
			if (index !== -1) {
				runs[index] = {
					terminal_id: result.value.terminal_id,
					command: run.command,
					args: run.args,
				};
			}
		}
	};
</script>

<div class="terminal_runner">
	<div class="run_history" {@attach scrollable.container} {@attach scrollable.target}>
		<div class="run_list">
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
		<p class="empty_state">no commands run yet — use a preset or type a command below</p>
	{/if}

	{#if error_message}
		<p class="error_message">{error_message}</p>
	{/if}

	<div class="input_area">
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
	.terminal_runner {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.run_history {
		flex: 1;
		overflow: auto;
		scrollbar-width: thin;
		display: flex;
		flex-direction: column-reverse;
	}
	.run_list {
		display: flex;
		flex-direction: column;
		gap: var(--space_md);
		padding: var(--space_md);
	}
	.empty_state {
		opacity: 0.5;
		text-align: center;
		padding: var(--space_xl);
	}
	.error_message {
		color: var(--color_c_50, #f88);
		padding: 0 var(--space_md);
		margin: 0;
	}
	.input_area {
		display: flex;
		flex-direction: column;
		gap: var(--space_sm);
		padding: var(--space_md);
		border-top: 1px solid var(--border_color, #333);
	}
</style>

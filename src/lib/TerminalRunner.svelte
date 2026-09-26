<script lang="ts">
	import { slide } from 'svelte/transition';

	import { app_context } from './app.svelte.ts';
	import type { TerminalPreset } from './terminal_preset.svelte.ts';
	import TerminalRunItem from './TerminalRunItem.svelte';
	import TerminalPresetBar from './TerminalPresetBar.svelte';
	import TerminalCommandInput from './TerminalCommandInput.svelte';
	import { Scrollable } from './scrollable.svelte.ts';
	import { parse_terminal_command } from './terminal_helpers.ts';

	const app = app_context.get();

	// runs and presets live in app state, so leaving this page doesn't lose
	// the terminals — their processes keep running and output keeps buffering
	const { terminals, terminal_presets } = app;

	const scrollable = new Scrollable();

	const handle_send = (command_text: string): void => {
		const parsed = parse_terminal_command(command_text);
		if (!parsed) return;
		void terminals.create(parsed);
	};

	const handle_preset = (preset: TerminalPreset): void => {
		void terminals.create({
			name: preset.name,
			command: preset.command,
			args: preset.args,
			cwd: preset.cwd,
			preset_id: preset.id
		});
	};

	const handle_preset_create = (name: string, command: string, args: Array<string>): void => {
		terminal_presets.add({ name, command, args });
	};

	const handle_preset_delete = (preset: TerminalPreset): void => {
		terminal_presets.remove(preset.id);
	};
</script>

<div class="terminal-runner">
	<div class="run-history" {@attach scrollable.container} {@attach scrollable.target}>
		<div class="run-list">
			{#each terminals.items.values as terminal (terminal.id)}
				<div transition:slide>
					<TerminalRunItem
						{terminal}
						onrestart={() => terminals.restart(terminal)}
						onremove={() => terminals.remove(terminal)}
					/>
				</div>
			{/each}
		</div>
	</div>

	{#if terminals.items.size === 0}
		<p class="empty-state">no commands run yet — use a preset or type a command below</p>
	{/if}

	<div class="input-area">
		<TerminalPresetBar
			presets={terminal_presets.items.values}
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
	.input-area {
		display: flex;
		flex-direction: column;
		gap: var(--space_sm);
		padding: var(--space_md);
		border-top: 1px solid var(--border_color, #333);
	}
</style>

<script lang="ts">
	import TerminalView from '$lib/TerminalView.svelte';
	import PageFooter from '$routes/PageFooter.svelte';
	import {app_context} from '$lib/app.svelte.js';
	import type {Uuid} from '$lib/zod_helpers.js';

	const app = app_context.get();

	let command_input: string = $state('');
	let active_terminals: Array<{terminal_id: Uuid}> = $state([]);

	const handle_create = async (): Promise<void> => {
		const trimmed = command_input.trim();
		if (!trimmed) return;

		const [command, ...args] = trimmed.split(/\s+/);
		if (!command) return;

		const result = await app.api.terminal_create({command, args});
		if (result.ok) {
			active_terminals.push({terminal_id: result.value.terminal_id});
			command_input = '';
		}
	};

	const handle_close =
		(terminal_id: Uuid) =>
		(_exit_code: number | null): void => {
			active_terminals = active_terminals.filter((t) => t.terminal_id !== terminal_id);
		};

	const handle_keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			void handle_create();
		}
	};
</script>

<div class="terminals_page">
	<header>
		<h1>Terminals</h1>
	</header>

	<div class="terminal_launcher">
		<input
			type="text"
			bind:value={command_input}
			placeholder="command (e.g. echo hello)"
			onkeydown={handle_keydown}
		/>
		<button type="button" onclick={handle_create} disabled={!command_input.trim()}>Run</button>
	</div>

	{#each active_terminals as { terminal_id } (terminal_id)}
		<div class="terminal_panel">
			<TerminalView {terminal_id} onclose={handle_close(terminal_id)} />
		</div>
	{/each}

	{#if active_terminals.length === 0}
		<p class="empty_state">no terminals running — type a command above to start one</p>
	{/if}
</div>

<PageFooter />

<style>
	.terminals_page {
		display: flex;
		flex-direction: column;
		gap: var(--space_md);
		padding: var(--space_md);
	}
	.terminal_launcher {
		display: flex;
		gap: var(--space_sm);
	}
	.terminal_launcher input {
		flex: 1;
	}
	.terminal_panel {
		height: 400px;
		border: 1px solid var(--border_color, #333);
		border-radius: var(--border_radius, 4px);
		overflow: hidden;
	}
	.empty_state {
		opacity: 0.5;
		text-align: center;
		padding: var(--space_xl);
	}
</style>

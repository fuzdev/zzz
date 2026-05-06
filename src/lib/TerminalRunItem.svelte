<script lang="ts">
	import type {Uuid} from '@fuzdev/fuz_util/id.js';

	import TerminalView from './TerminalView.svelte';
	import TerminalContextmenu from './TerminalContextmenu.svelte';
	import {GLYPH_RETRY} from './glyphs.js';
	import {app_context} from './app.svelte.js';

	const {
		terminal_id,
		command,
		args,
		onclose,
		onrestart,
	}: {
		terminal_id: Uuid;
		command: string;
		args: Array<string>;
		onclose: (exit_code: number | null) => void;
		onrestart?: () => void;
	} = $props();

	const app = app_context.get();

	let exit_code: number | null = $state.raw(null);
	let exited = $state.raw(false);
	let text_getter: (() => string) | null = $state.raw(null);
	let stdin_input: string = $state.raw('');

	const display_command = $derived(args.length > 0 ? `${command} ${args.join(' ')}` : command);

	const handle_close = (code: number | null): void => {
		if (exited) return; // already handled via terminal_exited notification
		exit_code = code;
		exited = true;
		onclose(code);
	};

	const handle_get_text = (fn: () => string): void => {
		text_getter = fn;
	};

	const send_stdin = (): void => {
		if (!stdin_input || exited) return;
		void app.api.terminal_data_send({terminal_id, data: stdin_input + '\n'});
		stdin_input = '';
	};

	const handle_stdin_keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			send_stdin();
		}
	};
</script>

<TerminalContextmenu get_terminal_text={text_getter} {display_command}>
	<div class="terminal-run-item">
		<div class="run-header">
			<span class="run-command">$ {display_command}</span>
			<span class="run-status">
				{#if exited}
					<span class="exit-code" class:error={exit_code !== 0}>
						exited {exit_code ?? '?'}
					</span>
				{:else}
					<span class="running">running</span>
				{/if}
			</span>
			{#if onrestart}
				<button type="button" class="restart-button" onclick={onrestart} title="restart">
					{GLYPH_RETRY}
				</button>
			{/if}
		</div>
		<div class="run-output">
			<TerminalView {terminal_id} onclose={handle_close} get_text={handle_get_text} />
		</div>
		<div class="stdin-input">
			<input
				type="text"
				bind:value={stdin_input}
				placeholder={exited ? 'process exited' : 'send input to terminal...'}
				onkeydown={handle_stdin_keydown}
				disabled={exited}
			/>
			<button type="button" onclick={send_stdin} disabled={exited || !stdin_input}>send</button>
		</div>
	</div>
</TerminalContextmenu>

<style>
	.terminal-run-item {
		border: 1px solid var(--border_color, #333);
		border-radius: var(--border_radius, 4px);
		overflow: hidden;
	}
	.run-header {
		display: flex;
		align-items: center;
		gap: var(--space_sm);
		padding: var(--space_xs) var(--space_sm);
		background: var(--bg_2, #1a1a2e);
		font-size: var(--font_size_sm);
	}
	.run-command {
		flex: 1;
		font-family: monospace;
		opacity: 0.8;
	}
	.run-status {
		font-size: var(--font_size_sm);
	}
	.running {
		color: var(--color_a_50, #8f8);
	}
	.exit-code {
		opacity: 0.6;
	}
	.exit-code.error {
		color: var(--color_c_50, #f88);
	}
	.restart-button {
		font-size: var(--font_size_sm);
	}
	.run-output {
		height: 300px;
	}
	.stdin-input {
		display: flex;
		gap: var(--space_xs);
		padding: var(--space_xs) var(--space_sm);
		border-top: 1px solid var(--border_color, #333);
		background: var(--bg_2, #1a1a2e);
	}
	.stdin-input input {
		flex: 1;
		font-family: monospace;
		font-size: var(--font_size_sm);
	}
</style>

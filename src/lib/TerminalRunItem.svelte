<script lang="ts">
	import TerminalView from './TerminalView.svelte';
	import TerminalContextmenu from './TerminalContextmenu.svelte';
	import type {Uuid} from './zod_helpers.js';
	import {GLYPH_RETRY} from './glyphs.js';

	interface Props {
		terminal_id: Uuid;
		command: string;
		args: Array<string>;
		onclose: (exit_code: number | null) => void;
		onrestart?: () => void;
	}

	const {terminal_id, command, args, onclose, onrestart}: Props = $props();

	let exit_code: number | null = $state(null);
	let exited = $state(false);
	let text_getter: (() => string) | null = $state(null);

	const display_command = $derived(args.length > 0 ? `${command} ${args.join(' ')}` : command);

	const handle_close = (code: number | null): void => {
		exit_code = code;
		exited = true;
		onclose(code);
	};

	const handle_get_text = (fn: () => string): void => {
		text_getter = fn;
	};
</script>

<TerminalContextmenu get_terminal_text={text_getter} {display_command}>
	<div class="terminal_run_item">
		<div class="run_header">
			<span class="run_command">$ {display_command}</span>
			<span class="run_status">
				{#if exited}
					<span class="exit_code" class:error={exit_code !== 0}>
						exited {exit_code ?? '?'}
					</span>
				{:else}
					<span class="running">running</span>
				{/if}
			</span>
			{#if onrestart}
				<button type="button" class="restart_button" onclick={onrestart} title="restart">
					{GLYPH_RETRY}
				</button>
			{/if}
		</div>
		<div class="run_output">
			<TerminalView {terminal_id} onclose={handle_close} get_text={handle_get_text} />
		</div>
	</div>
</TerminalContextmenu>

<style>
	.terminal_run_item {
		border: 1px solid var(--border_color, #333);
		border-radius: var(--border_radius, 4px);
		overflow: hidden;
	}
	.run_header {
		display: flex;
		align-items: center;
		gap: var(--space_sm);
		padding: var(--space_xs) var(--space_sm);
		background: var(--bg_2, #1a1a2e);
		font-size: var(--font_size_sm);
	}
	.run_command {
		flex: 1;
		font-family: monospace;
		opacity: 0.8;
	}
	.run_status {
		font-size: var(--font_size_xs);
	}
	.running {
		color: var(--color_a_50, #8f8);
	}
	.exit_code {
		opacity: 0.6;
	}
	.exit_code.error {
		color: var(--color_c_50, #f88);
	}
	.restart_button {
		font-size: var(--font_size_sm);
	}
	.run_output {
		height: 300px;
	}
</style>

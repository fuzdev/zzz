<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import { onMount } from 'svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	import type { Terminal } from './terminal.svelte.ts';

	const {
		terminal,
		get_text
	}: {
		terminal: Terminal;
		get_text?: (fn: () => string) => void;
	} = $props();

	let container_el: HTMLDivElement | undefined = $state.raw();
	let container_width: number = $state.raw(0);
	let container_height: number = $state.raw(0);
	let xterm_instance: any = $state.raw(null);
	let copy_text: string = $state.raw('');

	const get_terminal_text = (): string => {
		if (!xterm_instance) return '';
		const buffer = xterm_instance.buffer.active;
		const lines: Array<string> = [];
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (!line) continue;
			const text = line.translateToString(true);
			// join wrapped lines (long lines split across multiple rows)
			if (line.isWrapped && lines.length > 0) {
				lines[lines.length - 1] += text;
			} else {
				lines.push(text);
			}
		}
		// trim trailing empty lines and right-trim all lines
		while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
			lines.pop();
		}
		return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
	};

	// read xterm's buffer only when copying — `CopyToClipboard` reads its `text`
	// prop after calling `onclick`, and props are live, so it copies this fresh value
	const refresh_copy_text = (): void => {
		copy_text = get_terminal_text();
	};

	// reactively resize xterm when container dimensions change
	$effect(() => {
		if (!xterm_instance || container_width === 0 || container_height === 0) return;
		const core = xterm_instance._core; // access internal core for cell dimensions
		if (!core) return;
		const cell_width = core._renderService?.dimensions?.css?.cell?.width;
		const cell_height = core._renderService?.dimensions?.css?.cell?.height;
		if (!cell_width || !cell_height) return;
		const cols = Math.max(2, Math.floor(container_width / cell_width));
		const rows = Math.max(1, Math.floor(container_height / cell_height));
		xterm_instance.resize(cols, rows);
	});

	onMount(() => {
		let destroyed = false;
		let term: any = null;
		let detach_output: (() => void) | null = null;

		const setup = async (): Promise<void> => {
			const { Terminal: Xterm } = await import('@xterm/xterm');

			if (destroyed) return;

			// no `convertEol`: the output comes from a real PTY, whose line
			// discipline already turns `\n` into `\r\n` in cooked mode (ONLCR) —
			// a full-screen program that turns ONLCR off means a bare line feed
			term = new Xterm({
				cursorBlink: true,
				fontSize: 14,
				fontFamily: 'monospace',
				theme: {
					background: '#1a1a2e',
					foreground: '#e0e0e0'
				}
			});

			if (container_el) {
				term.open(container_el);
			}

			xterm_instance = term;

			// expose text getter to parent
			get_text?.(get_terminal_text);

			// the terminal cell buffers output whether or not a view is mounted —
			// replay what's buffered, then stream new output
			const attachment = terminal.attach_output((data) => {
				term.write(data);
			});
			detach_output = attachment.detach;
			if (attachment.truncated) {
				term.write('\x1b[0;2m[earlier output truncated]\x1b[0m\r\n');
			}
			// the history can contain queries (cursor position, device attributes,
			// colors) that xterm answers through `onData` — those answers were already
			// given when the output first arrived, so drop input until the replay is
			// parsed (xterm parses writes async, and queues live output after it)
			// this includes output that arrived before the first attach, e.g. a shell's
			// startup queries — replies to those are suppressed too
			let replaying = false;
			if (attachment.buffered) {
				replaying = true;
				term.write(attachment.buffered, () => {
					replaying = false;
				});
			}

			// input goes through the terminal's ordered send queue
			term.onData((data: string) => {
				if (replaying) return;
				terminal.send_input(data);
			});

			term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
				terminal.resize(cols, rows);
			});
		};

		void setup();

		// the process keeps running — unmounting only detaches this view
		return () => {
			destroyed = true;
			detach_output?.();
			term?.dispose();
		};
	});
</script>

<div class="terminal-view">
	<div class="terminal-header">
		<span class="terminal-id">terminal {terminal.terminal_id?.slice(0, 8) ?? '…'}</span>
		<div class="terminal-actions">
			<CopyToClipboard
				text={copy_text}
				allow_copying_empty_string
				disabled={!xterm_instance}
				onclick={refresh_copy_text}
				class="plain"
			/>
			<button
				type="button"
				onclick={() => terminal.close()}
				disabled={!terminal.running || terminal.closing}
			>
				{terminal.closing ? 'closing…' : 'close'}
			</button>
		</div>
	</div>
	{#if terminal.output_gap && terminal.running}
		<p class="output-gap" role="status">
			<small>connection lost — some output may be missing</small>
			<button type="button" class="plain" onclick={() => (terminal.output_gap = false)}>
				dismiss
			</button>
		</p>
	{/if}
	<div
		class="terminal-container"
		bind:this={container_el}
		bind:clientWidth={container_width}
		bind:clientHeight={container_height}
	></div>
</div>

<style>
	.terminal-view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 300px;
	}
	.terminal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space_xs);
		background: var(--bg_2, #1a1a2e);
	}
	.terminal-id {
		font-size: var(--font_size_sm);
		opacity: 0.7;
	}
	.terminal-actions {
		display: flex;
		gap: var(--space_xs);
		align-items: center;
	}
	.output-gap {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space_sm);
		margin: 0;
		padding: var(--space_xs3) var(--space_xs);
		background: var(--bg_2, #1a1a2e);
	}
	.terminal-container {
		flex: 1;
		overflow: hidden;
	}
</style>

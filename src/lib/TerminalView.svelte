<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import {onMount} from 'svelte';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	import {app_context} from './app.svelte.js';
	import type {Uuid} from './zod_helpers.js';

	interface Props {
		terminal_id: Uuid;
		onclose?: (exit_code: number | null) => void;
		get_text?: (fn: () => string) => void;
	}

	const {terminal_id, onclose, get_text}: Props = $props();

	const app = app_context.get();

	let container_el: HTMLDivElement | undefined = $state();
	let container_width: number = $state(0);
	let container_height: number = $state(0);
	let xterm_instance: any = $state(null);
	let data_version: number = $state(0); // incremented on each write to trigger re-derivation
	let exited = $state(false);

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

	// re-derives when xterm_instance is set or data_version changes
	const terminal_text: string = $derived.by(() => {
		void data_version; // track to re-derive on new data
		return get_terminal_text();
	});

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

		// buffer data that arrives before xterm is ready
		const pending_data: Array<string> = [];

		// register writer immediately to capture early data
		app.terminal_writers.set(terminal_id, (data: string) => {
			if (term) {
				term.write(data);
			} else {
				pending_data.push(data);
			}
			data_version++;
		});

		// register exit handler for backend-initiated exit notifications
		app.terminal_exit_handlers.set(terminal_id, (exit_code: number | null) => {
			exited = true;
			onclose?.(exit_code);
		});

		const setup = async (): Promise<void> => {
			const {Terminal} = await import('@xterm/xterm');

			if (destroyed) return;

			term = new Terminal({
				cursorBlink: true,
				convertEol: true,
				fontSize: 14,
				fontFamily: 'monospace',
				theme: {
					background: '#1a1a2e',
					foreground: '#e0e0e0',
				},
			});

			if (container_el) {
				term.open(container_el);
			}

			xterm_instance = term;

			// expose text getter to parent
			get_text?.(get_terminal_text);

			// replay any buffered data
			for (const data of pending_data) {
				term.write(data);
			}
			pending_data.length = 0;

			// send user input to backend
			term.onData((data: string) => {
				void app.api.terminal_data_send({
					terminal_id,
					data,
				});
			});

			// notify backend of resize
			term.onResize(({cols, rows}: {cols: number; rows: number}) => {
				void app.api.terminal_resize({
					terminal_id,
					cols,
					rows,
				});
			});
		};

		void setup();

		return () => {
			destroyed = true;
			app.terminal_writers.delete(terminal_id);
			app.terminal_exit_handlers.delete(terminal_id);
			term?.dispose();
		};
	});

	const handle_close = async (): Promise<void> => {
		if (exited) return; // already exited via notification
		const result = await app.api.terminal_close({terminal_id});
		exited = true;
		onclose?.(result.ok ? (result.value?.exit_code ?? null) : null);
	};
</script>

<div class="terminal_view">
	<div class="terminal_header">
		<span class="terminal_id">terminal {terminal_id.slice(0, 8)}</span>
		<div class="terminal_actions">
			<CopyToClipboard text={terminal_text} class="plain" />
			<button type="button" onclick={handle_close}>close</button>
		</div>
	</div>
	<div
		class="terminal_container"
		bind:this={container_el}
		bind:clientWidth={container_width}
		bind:clientHeight={container_height}
	></div>
</div>

<style>
	.terminal_view {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 300px;
	}
	.terminal_header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space_xs);
		background: var(--bg_2, #1a1a2e);
	}
	.terminal_id {
		font-size: var(--font_size_sm);
		opacity: 0.7;
	}
	.terminal_actions {
		display: flex;
		gap: var(--space_xs);
		align-items: center;
	}
	.terminal_container {
		flex: 1;
		overflow: hidden;
	}
</style>

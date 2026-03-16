<script lang="ts">
	import '@xterm/xterm/css/xterm.css';
	import {onMount} from 'svelte';

	import {app_context} from './app.svelte.js';
	import type {Uuid} from './zod_helpers.js';

	interface Props {
		terminal_id: Uuid;
		onclose?: (exit_code: number | null) => void;
	}

	const {terminal_id, onclose}: Props = $props();

	const app = app_context.get();

	let container_el: HTMLDivElement | undefined = $state();
	let container_width: number = $state(0);
	let container_height: number = $state(0);
	let xterm_instance: any = $state(null);

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
		});

		const setup = async (): Promise<void> => {
			const {Terminal} = await import('@xterm/xterm');

			if (destroyed) return;

			term = new Terminal({
				cursorBlink: true,
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
			term?.dispose();
		};
	});

	const handle_close = async (): Promise<void> => {
		const result = await app.api.terminal_close({terminal_id});
		onclose?.(result.ok ? result.value.exit_code : null);
	};
</script>

<div class="terminal_view">
	<div class="terminal_header">
		<span class="terminal_id">terminal {terminal_id.slice(0, 8)}</span>
		<button type="button" onclick={handle_close}>close</button>
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
	.terminal_container {
		flex: 1;
		overflow: hidden;
	}
</style>

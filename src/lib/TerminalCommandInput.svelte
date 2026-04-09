<script lang="ts">
	interface Props {
		onsend: (command_text: string) => void;
	}

	const {onsend}: Props = $props();

	let input = $state.raw('');

	const send = (): void => {
		const trimmed = input.trim();
		if (!trimmed) return;
		input = '';
		onsend(trimmed);
	};

	const handle_keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			send();
		}
	};
</script>

<div class="terminal_command_input">
	<input
		type="text"
		bind:value={input}
		placeholder="command (e.g. echo hello)"
		onkeydown={handle_keydown}
	/>
	<button type="button" onclick={send} disabled={!input.trim()}>Run</button>
</div>

<style>
	.terminal_command_input {
		display: flex;
		gap: var(--space_sm);
	}
	.terminal_command_input input {
		flex: 1;
	}
</style>

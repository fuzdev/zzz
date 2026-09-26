<script lang="ts">
	import { icon_play, icon_add, icon_remove } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';

	import type { TerminalPreset } from './terminal_preset.svelte.ts';
	import { parse_terminal_command } from './terminal_helpers.ts';

	const {
		presets,
		onrun,
		oncreate,
		ondelete
	}: {
		presets: ReadonlyArray<TerminalPreset>;
		onrun: (preset: TerminalPreset) => void;
		oncreate?: (name: string, command: string, args: Array<string>) => void;
		ondelete?: (preset: TerminalPreset) => void;
	} = $props();

	let adding = $state.raw(false);
	let new_name = $state.raw('');
	let new_command = $state.raw('');

	const handle_add_submit = (): void => {
		const parsed = parse_terminal_command(new_command);
		if (!parsed) return;
		const { command, args } = parsed;
		oncreate?.(new_name.trim() || command, command, args);
		new_name = '';
		new_command = '';
		adding = false;
	};

	const handle_add_keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			handle_add_submit();
		} else if (e.key === 'Escape') {
			adding = false;
		}
	};
</script>

<div class="terminal-preset-bar">
	{#each presets as preset (preset.id)}
		<span class="preset-item">
			<button type="button" onclick={() => onrun(preset)}>
				<Icon data={icon_play} />
				{preset.name || preset.command}
			</button>
			{#if ondelete}
				<button
					type="button"
					class="preset-delete"
					onclick={() => ondelete(preset)}
					title="delete preset"
				>
					<Icon data={icon_remove} />
				</button>
			{/if}
		</span>
	{/each}

	{#if oncreate}
		{#if adding}
			<span class="preset-add-form">
				<input
					type="text"
					bind:value={new_name}
					placeholder="name"
					class="preset-input preset-input-name"
					onkeydown={handle_add_keydown}
				/>
				<input
					type="text"
					bind:value={new_command}
					placeholder="command args..."
					class="preset-input preset-input-command"
					onkeydown={handle_add_keydown}
				/>
				<button type="button" onclick={handle_add_submit}><Icon data={icon_add} /></button>
				<button type="button" onclick={() => (adding = false)}><Icon data={icon_remove} /></button>
			</span>
		{:else}
			<button type="button" onclick={() => (adding = true)} title="add preset">
				<Icon data={icon_add} />
			</button>
		{/if}
	{/if}
</div>

<style>
	.terminal-preset-bar {
		display: flex;
		gap: var(--space_xs);
		flex-wrap: wrap;
		align-items: center;
	}
	.preset-item {
		display: inline-flex;
		align-items: center;
		gap: 0;
	}
	.preset-delete {
		font-size: var(--font_size_xs);
		padding: var(--space_xs2);
		opacity: 0.5;
	}
	.preset-delete:hover {
		opacity: 1;
	}
	.preset-add-form {
		display: inline-flex;
		gap: var(--space_xs);
		align-items: center;
	}
	.preset-input {
		font-size: var(--font_size_sm);
		padding: var(--space_xs);
	}
	.preset-input-name {
		width: 6em;
	}
	.preset-input-command {
		width: 12em;
	}
</style>

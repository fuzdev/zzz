<script lang="ts">
	// @slop Claude Sonnet 3.7

	import {slide} from 'svelte/transition';
	import {formatDuration, intervalToDuration} from 'date-fns';
	import {BROWSER} from 'esm-env';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import {frontend_context} from './frontend.svelte.js';
	import type {Socket} from './socket.svelte.js';
	import ConfirmButton from './ConfirmButton.svelte';
	import Glyph from './Glyph.svelte';
	import {
		GLYPH_CONNECT,
		GLYPH_CANCEL,
		GLYPH_DISCONNECT,
		GLYPH_RESET,
		GLYPH_PLACEHOLDER,
	} from './glyphs.js';
	import {format_ms_to_readable, format_timestamp} from './time_helpers.js';
	import {
		DEFAULT_HEARTBEAT_INTERVAL,
		DEFAULT_RECONNECT_DELAY,
		DEFAULT_RECONNECT_DELAY_MAX,
	} from './socket_helpers.js';
	import SocketMessageQueue from './SocketMessageQueue.svelte';
	import {WEBSOCKET_URL} from './constants.js';

	const pid = $props.id();

	const {
		socket: socket_prop,
	}: {
		socket?: Socket | undefined;
	} = $props();

	// Get socket from props or context
	const app = frontend_context.get();
	const socket = $derived(socket_prop || app.socket);
	const {capabilities} = app;

	// Track URL state for reset/undo functionality
	let previous_url = $state('');
	let has_undo_state = $state(false);

	// Reset the socket configuration to defaults
	const reset_to_defaults = () => {
		socket.heartbeat_interval = DEFAULT_HEARTBEAT_INTERVAL;
		socket.reconnect_delay = DEFAULT_RECONNECT_DELAY;
		socket.reconnect_delay_max = DEFAULT_RECONNECT_DELAY_MAX;
	};

	// Reset the URL to the default value
	const reset_url = () => {
		if (socket.url_input !== WEBSOCKET_URL) {
			previous_url = socket.url_input;
			has_undo_state = true;
			socket.url_input = WEBSOCKET_URL;
		}
	};

	// Restore the previous URL
	const restore_previous_url = () => {
		if (previous_url) {
			socket.url_input = previous_url;
			previous_url = '';
			has_undo_state = false;
		}
	};

	// Check if the current URL is the default
	const is_default_url = $derived(socket.url_input === WEBSOCKET_URL); // TODO maybe move to `socket.url_input_is_default`
</script>

<!-- Main control section with flex layout for wide screens -->
<form class="display:flex flex-wrap:wrap gap_xl mb_md">
	<!-- Left column: Connection status and controls -->
	<div class="flex:1 width_atleast_sm">
		<!-- Status display -->

		<!-- URL input and connect/disconnect -->
		<div class="display:flex flex-direction:column gap_sm mb_sm">
			<div
				class="chip plain flex:1 font_size_xl px_xl flex-direction:column"
				style:display="display:flex !important"
				style:align-items="flex-start !important"
				style:font-weight="400 !important"
				class:color_b={capabilities.websocket.status === 'success' && socket.connected}
				class:color_c={capabilities.websocket.status === 'failure'}
				class:color_d={capabilities.websocket.status === 'pending'}
				class:color_e={capabilities.websocket.status === 'initial'}
				class:color_h={capabilities.websocket.status === 'success' && !socket.connected}
			>
				<div class="column justify-content:center gap_xs pl_md" style:min-height="80px">
					<span
						>websocket {socket.connected
							? 'connected'
							: socket.status === 'pending'
								? 'connecting'
								: 'disconnected'}{#if socket.status === 'pending'}
							<PendingAnimation inline class="ml_sm" />{/if}</span
					>
					<small class="font_family_mono"
						>{#if socket.url}{socket.url}{:else}&nbsp;{/if}</small
					>
				</div>
			</div>

			<fieldset class="mb_0">
				<div class="display:flex gap_xs mb_sm">
					<input
						type="text"
						class="plain flex:1"
						placeholder="{GLYPH_PLACEHOLDER} websocket url, ws:// or wss://"
						bind:value={socket.url_input}
					/>
					<button
						type="button"
						class="icon_button plain"
						title={has_undo_state ? `undo to ${previous_url}` : 'reset url to default'}
						disabled={is_default_url && !has_undo_state}
						onclick={() => {
							if (has_undo_state) {
								restore_previous_url();
							} else {
								reset_url();
							}
						}}
					>
						<div class={has_undo_state ? 'transform:scaleX(-1)' : ''}>
							<Glyph glyph={GLYPH_RESET} />
						</div>
					</button>
				</div>

				<div class="display:flex justify-content:space-between gap_md">
					<button
						type="button"
						class="flex:1 justify-content:start"
						class:color_d={socket.connected &&
							socket.url !== socket.url_input &&
							socket.url_input !== ''}
						class:color_a={!socket.connected && socket.status !== 'pending'}
						disabled={socket.status === 'pending' || (!socket.connected && !socket.url_input)}
						onclick={() => {
							if (socket.connected) {
								if (socket.url !== socket.url_input && socket.url_input !== '') {
									socket.disconnect();
									socket.connect();
								} else {
									socket.disconnect();
								}
							} else if (socket.status === 'failure' && socket.url) {
								socket.connect();
							} else if (socket.url_input) {
								socket.connect();
							}
						}}
					>
						<Glyph
							glyph={socket.connected && socket.url === socket.url_input
								? GLYPH_DISCONNECT
								: GLYPH_CONNECT}
							size="var(--font_size_xl)"
						/>
						<span class="font_size_lg font-weight:400 ml_md">
							{#if !BROWSER}
								<div class="display:inline-flex align-items:end">
									loading <div class="position:relative"><PendingAnimation /></div>
								</div>
							{:else if socket.connected}
								{socket.url !== socket.url_input && socket.url_input !== ''
									? 'reconnect websocket'
									: 'disconnect websocket'}
							{:else if socket.status === 'pending'}
								<div class="display:inline-flex align-items:end">
									connecting <div class="position:relative"><PendingAnimation /></div>
								</div>
							{:else}
								connect websocket
							{/if}
						</span>
					</button>
				</div>
			</fieldset>

			<div class="display:flex">
				<label class="display:flex gap_xs align-items:center my_sm">
					<input
						type="checkbox"
						class="compact font_size_sm"
						bind:checked={
							() => socket.auto_reconnect,
							(v) => {
								// If turning off auto-reconnect, cancel any pending reconnects
								if (!v && socket.reconnect_timeout !== null) {
									socket.cancel_reconnect();
								} else if (v && !socket.connected && socket.status !== 'pending') {
									// If turning on auto-reconnect and we're disconnected, try to connect immediately
									socket.connect();
								}
								socket.auto_reconnect = v;
							}
						}
					/>
					<small>auto-reconnect</small>
				</label>
				{#if socket.status === 'failure' && socket.reconnect_timeout !== null}
					<div class="row flex:1 gap_xs" transition:slide>
						<button
							type="button"
							class="color_d font_size_xl icon_button plain"
							title="cancel reconnection attempt"
							onclick={() => {
								socket.cancel_reconnect();
							}}
						>
							<Glyph glyph={GLYPH_CANCEL} />
						</button>
						<div
							class="bg_d_5 width:100% border_radius_xs position:relative overflow:hidden font-weight:600"
							style:height="24px"
						>
							<div
								class="position:absolute width:100% height:100% row px_lg font_family_mono"
								style:z-index="2"
							>
								reconnecting in...
							</div>
							{#key socket.reconnect_attempt}
								<div
									class="progress_fill bg_d_6"
									style:animation-duration="{socket.current_reconnect_delay}ms"
								></div>
							{/key}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Right column: Config sliders -->
	<div class="flex:1 width_atleast_sm p_sm border_radius_xs">
		<fieldset class="display:flex flex-direction:column gap_sm">
			<div class="row">
				<label
					for="heartbeat_interval_{pid}"
					class="display:block white-space:nowrap mb_xs"
					style:width="170px"
					style:min-width="170px"
				>
					<div>heartbeat interval</div>
					<small>{format_ms_to_readable(socket.heartbeat_interval)}</small>
				</label>
				<div class="display:flex gap_xs">
					<input
						type="range"
						min="10000"
						max="600000"
						step="10000"
						class="flex:1 compact plain"
						bind:value={socket.heartbeat_interval}
					/>
					<input
						id="heartbeat_interval_{pid}"
						type="text"
						class="input_xs compact plain"
						bind:value={socket.heartbeat_interval}
					/>
				</div>
			</div>

			<div class="row">
				<label
					for="reconnect_delay_{pid}"
					class="display:block white-space:nowrap mb_xs"
					style:width="170px"
					style:min-width="170px"
				>
					<div>reconnect delay</div>
					<small>{format_ms_to_readable(socket.reconnect_delay, 1)}</small>
				</label>
				<div class="display:flex gap_xs">
					<input
						type="range"
						min="100"
						max="10000"
						step="100"
						class="flex:1 compact plain"
						bind:value={socket.reconnect_delay}
					/>
					<input
						id="reconnect_delay_{pid}"
						type="text"
						class="input_xs compact plain"
						bind:value={socket.reconnect_delay}
					/>
				</div>
			</div>

			<div class="row">
				<label
					for="reconnect_delay_max_{pid}"
					class="display:block white-space:nowrap mb_xs"
					style:width="170px"
					style:min-width="170px"
				>
					<div>max reconnect delay</div>
					<small>{format_ms_to_readable(socket.reconnect_delay_max)}</small>
				</label>
				<div class="display:flex gap_xs">
					<input
						type="range"
						min="1000"
						max="300000"
						step="1000"
						class="flex:1 compact plain"
						bind:value={socket.reconnect_delay_max}
					/>
					<input
						id="reconnect_delay_max_{pid}"
						type="text"
						class="input_xs compact plain"
						bind:value={socket.reconnect_delay_max}
					/>
				</div>
			</div>

			<div class="display:flex justify-content:end">
				<ConfirmButton
					onconfirm={reset_to_defaults}
					class="plain font_size_sm compact font-weight:600"
				>
					reset to defaults

					{#snippet popover_content(popover)}
						<button
							type="button"
							class="color_c icon_button"
							title="confirm reset settings"
							onclick={() => {
								reset_to_defaults();
								popover.hide();
							}}
						>
							<Glyph glyph={GLYPH_RESET} />
						</button>
					{/snippet}
				</ConfirmButton>
			</div>
		</fieldset>
	</div>
</form>

<div class="display:flex gap_xl5">
	<!-- Connection Stats with retries included -->
	<div class="width_upto_xs mt_md border_top pt_md">
		<div class="display:flex flex-direction:column gap_sm mb_sm">
			{#if socket.reconnect_count > 0}
				<div class="display:flex justify-content:space-between" transition:slide>
					<small>reconnection attempts:</small>
					<span class="font-weight:600">{socket.reconnect_count}</span>
				</div>
				<div class="display:flex justify-content:space-between" transition:slide>
					<small>current reconnect delay:</small>
					<span class="font-weight:600">{socket.current_reconnect_delay}</span>
				</div>
			{/if}

			<div class="display:flex justify-content:space-between">
				<small>connected for:</small>
				<small>
					{socket.connection_duration_rounded
						? formatDuration(
								intervalToDuration({start: 0, end: socket.connection_duration_rounded}),
							)
						: '-'}
				</small>
			</div>
			<div class="display:flex justify-content:space-between">
				<small>connected:</small>
				<small>{format_timestamp(socket.last_connect_time)}</small>
			</div>
			<div class="display:flex justify-content:space-between">
				<small>last send:</small>
				<small>{format_timestamp(socket.last_send_time)}</small>
			</div>
			<div class="display:flex justify-content:space-between">
				<small>last receive:</small>
				<small>{format_timestamp(socket.last_receive_time)}</small>
			</div>
		</div>
	</div>
</div>

<!-- Message Queue Stats -->
{#if socket.queued_message_count > 0 || socket.failed_message_count > 0}
	<div class="mt_md border_top pt_md" transition:slide>
		<h4 class="mt_0 mb_sm">message queue</h4>

		<div class="display:flex flex-direction:column gap_md mb_sm">
			{#if socket.queued_message_count > 0}
				<SocketMessageQueue {socket} type="queued" />
			{/if}

			{#if socket.failed_message_count > 0}
				<SocketMessageQueue {socket} type="failed" />
			{/if}
		</div>
	</div>
{/if}

<style>
	@keyframes progress-animation {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(0);
		}
	}

	.progress_fill {
		position: absolute;
		width: 100%;
		height: 100%;
		transform: translateX(-100%);
		animation: progress-animation linear forwards;
		z-index: 1;
	}
</style>

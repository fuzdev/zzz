<script lang="ts">
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';

	import Icon from './Icon.svelte';
	import { get_icon_for_action_kind } from './action_icons.ts';
	import type { RecentIntent } from './recent_intents.svelte.ts';
	import { format_datetime, format_time } from './time_helpers.ts';

	/** One recent intent's whole entry, as the actions page shows a selected one. */
	const {
		entry
	}: {
		entry: RecentIntent;
	} = $props();

	// an input the schema let through can still fail to stringify (a cycle, a bigint)
	const json = $derived.by(() => {
		try {
			return JSON.stringify(entry, null, 2);
		} catch {
			return JSON.stringify({ ...entry, input: '(not shown)' }, null, 2);
		}
	});
</script>

<div class="mb_md">
	<h3 class="mt_md">
		<Icon data={get_icon_for_action_kind('local_call')} />
		{entry.method}
	</h3>
	<table>
		<tbody class="font_family_mono">
			<tr>
				<td>at</td>
				<td>{format_datetime(entry.at)} {format_time(entry.at)}</td>
			</tr>
			<tr>
				<td>version</td>
				<td>{entry.version}</td>
			</tr>
			<tr>
				<td>history</td>
				<td>{entry.history}</td>
			</tr>
			<tr>
				<td>outcome</td>
				<td class:color_c_60={entry.outcome === 'failed'}>{entry.outcome}</td>
			</tr>
			{#if entry.error !== null}
				<tr>
					<td>error</td>
					<td class="color_c_60">{entry.error}</td>
				</tr>
			{/if}
		</tbody>
	</table>
</div>

<div class="flex gap_md mb_sm">
	<CopyToClipboard text={json} class="plain" />
</div>
<pre
	class="font_family_mono font_size_sm white-space:pre-wrap word-break:break-word p_sm width:100%"
>{json}</pre>

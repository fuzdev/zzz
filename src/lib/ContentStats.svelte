<script lang="ts">
	import {print_number_with_separators} from '@fuzdev/fuz_util/print.js';

	const {
		token_count,
	}: {
		token_count: number;
	} = $props();
</script>

<div class="display:flex gap_xs font_family_mono font_size_sm">
	{#if !token_count}
		&nbsp;
	{:else}
		<div
			title="the token count is currently approximated using just one algorithm, when in practice models differ"
		>
			≈ {print_number_with_separators(token_count + '')} token{token_count === 1 ? '' : 's'}
		</div>
	{/if}
</div>

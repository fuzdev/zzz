<script lang="ts">
	import {fade} from 'svelte/transition';
	import CopyToClipboard from '@fuzdev/fuz_ui/CopyToClipboard.svelte';
	import {random_item} from '@fuzdev/fuz_util/random.js';

	import ConfirmButton from './ConfirmButton.svelte';
	import Glyph from './Glyph.svelte';
	import PartView from './PartView.svelte';
	import {
		GLYPH_PART,
		GLYPH_ADD,
		GLYPH_PROMPT,
		GLYPH_REMOVE,
		GLYPH_DELETE,
		GLYPH_FILE,
		GLYPH_SORT,
	} from './glyphs.js';
	import {frontend_context} from './frontend.svelte.js';
	import PromptStats from './PromptStats.svelte';
	import PartList from './PartList.svelte';
	import ContentPreview from './ContentPreview.svelte';
	import {Part} from './part.svelte.js';
	import PromptContextmenu from './PromptContextmenu.svelte';
	import DiskfilePickerDialog from './DiskfilePickerDialog.svelte';
	import PromptList from './PromptList.svelte';
	import EditableText from './EditableText.svelte';
	import TutorialForDatabase from './TutorialForDatabase.svelte';
	import TutorialForPrompts from './TutorialForPrompts.svelte';
	import {DURATION_SM} from './helpers.js';

	const app = frontend_context.get();

	// TODO hovering/selecting parts should show them hovered/selected in both the grid and list

	// TODO clicking the parts should select them, and then selected one should show its name input (or just on hover/tap? what signifier?)

	// TODO history of prompt states (opt in snapshots? also autosave?) using cell builtins/helpers, like file state but generalized for all cells? the json-based, set_json stuff

	let show_diskfile_picker = $state(false);

	// Create and add a Text part
	const add_text_part = () => {
		if (!app.prompts.selected) return;

		const part = Part.create(app, {
			type: 'text',
			content: '',
		});

		app.prompts.selected.add_part(part);
	};

	// Create and add a Diskfile part
	const add_diskfile_part = () => {
		if (!app.prompts.selected) return;

		// Show the diskfile picker dialog
		show_diskfile_picker = true;
	};

	// TODO refactor, maybe move the nav and init logic to `Prompts`?
	const create_prompt = async () => {
		const prompt = app.prompts.add();
		await app.prompts.navigate_to(prompt.id);
	};
</script>

<div class="display:flex width:100% height:100%">
	<div class="column_fixed">
		<div class="p_sm pl_0">
			<div class="row gap_xs2 mb_xs pl_xs2">
				<button
					type="button"
					class="plain width:100% justify-content:start"
					onclick={create_prompt}
				>
					<Glyph glyph={GLYPH_ADD} />&nbsp; new prompt
				</button>
				{#if app.prompts.items.size > 1}
					<button
						type="button"
						class="plain compact selectable deselectable"
						class:selected={app.prompts.show_sort_controls}
						title="toggle sort controls"
						onclick={() => app.prompts.toggle_sort_controls()}
					>
						<Glyph glyph={GLYPH_SORT} />
					</button>
				{/if}
			</div>
			<PromptList />
		</div>
		<TutorialForDatabase />
		<TutorialForPrompts />
	</div>

	{#if app.prompts.selected}
		<PromptContextmenu prompt={app.prompts.selected}>
			<div class="column_fixed pr_sm">
				<section class="column_section">
					<div class="font_size_lg display:flex align-items:center">
						<Glyph glyph={GLYPH_PROMPT} />
						<EditableText bind:value={app.prompts.selected.name} />
					</div>
					<div class="column">
						<small>created {app.prompts.selected.created_formatted_short_date}</small>
						<small>
							{app.prompts.selected.parts.length}
							part{#if app.prompts.selected.parts.length !== 1}s{/if}
						</small>
					</div>
					<div class="row gap_xs py_xs">
						<CopyToClipboard text={app.prompts.selected.content} class="plain" />
						<div class="flex:1">
							<PromptStats prompt={app.prompts.selected} />
						</div>
						<ConfirmButton
							onconfirm={() => app.prompts.selected && app.prompts.remove(app.prompts.selected)}
							title="delete prompt {'"' + app.prompts.selected.name + '"'}"
							class="plain icon_button"
						>
							<Glyph glyph={GLYPH_DELETE} />
							{#snippet popover_button_content()}<Glyph glyph={GLYPH_DELETE} />{/snippet}
						</ConfirmButton>
					</div>
					<ContentPreview content={app.prompts.selected.content} />
				</section>
				<section class="column_section">
					<header class="font_size_lg mb_lg"><Glyph glyph={GLYPH_PART} /> parts</header>
					<PartList
						parts={app.prompts.selected.parts}
						prompt={app.prompts.selected}
						onreorder={(from_index, to_index) => {
							app.prompts.selected?.reorder_parts(from_index, to_index);
						}}
					/>
				</section>
			</div>

			<div class="column_fluid">
				<div class="column_bg_1 column gap_md p_sm">
					<div class="display:flex justify-content:space-between">
						<div class="display:flex flex-wrap:wrap gap_xs">
							<button type="button" class="plain font_size_sm" onclick={add_text_part}>
								<div class="row white-space:nowrap">
									<Glyph glyph={GLYPH_PART} />&nbsp; add text
								</div>
							</button>
							<button
								type="button"
								class="plain font_size_sm"
								onclick={add_diskfile_part}
								disabled={!app.diskfiles.items.size}
							>
								<div class="row white-space:nowrap">
									<Glyph glyph={GLYPH_FILE} />&nbsp; add file
								</div>
							</button>
							<ConfirmButton
								onconfirm={() => app.prompts.selected?.remove_all_parts()}
								disabled={!app.prompts.selected.parts.length}
								class="plain font_size_sm"
							>
								<div class="row white-space:nowrap">
									<Glyph glyph={GLYPH_REMOVE} />&nbsp; remove all
								</div>
							</ConfirmButton>
						</div>
					</div>
					<ul
						class="unstyled display:grid gap_md"
						style:grid-template-columns="repeat(auto-fill, minmax(300px, 1fr))"
					>
						{#each app.prompts.selected.parts as part (part.id)}
							<li in:fade={{duration: DURATION_SM}}>
								<!-- the extra wrapper makes the grid items not stretch vertically -->
								<div class="bg border_radius_xs p_sm">
									<PartView {part} />
								</div>
							</li>
						{/each}
					</ul>
				</div>
			</div>
		</PromptContextmenu>
	{:else if app.prompts.items.size}
		<div class="box height:100% flex:1" in:fade={{duration: DURATION_SM}}>
			<p>
				select a prompt from the list or <button
					type="button"
					class="inline color_d"
					onclick={create_prompt}>create one</button
				>
				or
				<button
					type="button"
					class="inline color_f"
					onclick={async () => {
						const prompt = random_item(app.prompts.ordered_items);
						await app.prompts.navigate_to(prompt.id);
					}}>go fish</button
				>?
			</p>
		</div>
	{:else}
		<div class="box height:100% flex:1" in:fade={{duration: DURATION_SM}}>
			<p>
				no prompts yet, <button type="button" class="inline color_d" onclick={create_prompt}
					>create a new prompt</button
				>?
			</p>
		</div>
	{/if}
</div>

<DiskfilePickerDialog
	bind:show={show_diskfile_picker}
	onpick={(diskfile) => {
		if (!app.prompts.selected || !diskfile) return false;

		const part = Part.create(app, {
			type: 'diskfile',
			path: diskfile.path,
		});

		app.prompts.selected.add_part(part);
		return true;
	}}
/>

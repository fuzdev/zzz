<script lang="ts">
	import {frontend_context} from './frontend.svelte.js';
	import type {ChatTemplate} from './chat_template.js';
	import type {Model} from './model.svelte.js';
	import ModelPicker from './ModelPicker.svelte';
	import type {Uuid} from './zod_helpers.js';
	import type {Chat} from './chat.svelte.js';
	import ProviderLogo from './ProviderLogo.svelte';

	const app = frontend_context.get();

	const {
		chat: chat_prop,
		oninit,
		heading = 'create new chat',
		items,
	}: {
		chat?: Chat;
		oninit?: (chat_id: Uuid) => void;
		heading?: string;
		items?: Array<Model>;
	} = $props();

	const get_or_create_chat = () => chat_prop ?? app.chats.add();

	const init_from_template = (template: ChatTemplate): void => {
		const chat = get_or_create_chat();

		const models = app.models.filter_by_names(template.model_names);
		if (models && models.length > 0) {
			for (const model of models) {
				chat.add_thread(model);
			}

			if (models.length >= 2) {
				chat.view_mode = 'multi';
			}
		}

		oninit?.(chat.id);
	};

	const init_with_model = (model: Model): void => {
		const chat = get_or_create_chat();

		chat.add_thread(model);

		oninit?.(chat.id);
	};
</script>

{#if heading}
	<h2 class="mt_0 mb_lg">{heading}</h2>
{/if}

<div class="display:flex">
	<section class="width_atmost_sm width_atleast_sm">
		<h3 class="mt_0 mb_lg">with model</h3>
		<ModelPicker
			onpick={(model) => {
				if (model) {
					init_with_model(model);
				}
			}}
			{items}
			heading=""
		/>
	</section>

	<section class="width_atmost_sm width_atleast_sm">
		<h3 class="mt_0 mb_lg px_md">from template</h3>
		<menu class="unstyled column gap_xs px_md">
			{#each app.chats.chat_templates as chat_template (chat_template.id)}
				<button
					type="button"
					class="plain selectable width:100% py_sm text-align:left justify-content:start font-weight:400"
					onclick={() => init_from_template(chat_template)}
				>
					<div>
						<div class="font_size_lg mb_sm">{chat_template.name}</div>
						<div class="display:flex flex-wrap:wrap gap_xs2">
							{#each chat_template.model_names as model_name (model_name)}
								{@const provider_name = app.models.find_by_name(model_name)?.provider_name}
								<small class="chip"
									>{#if provider_name}<ProviderLogo
											name={provider_name}
											size="var(--font_size_xs)"
										/>&nbsp;{/if}{model_name}</small
								>
							{/each}
						</div>
					</div>
				</button>
			{/each}
		</menu>
	</section>
</div>

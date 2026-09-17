import type { Library } from '@fuzdev/fuz_ui/library.svelte.ts';
import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

export const library_context = create_context<Library>();

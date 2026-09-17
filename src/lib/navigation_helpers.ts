import { goto } from '$app/navigation';
import { page } from '$app/state';

/**
 * Navigate to a path only if we're not already on that path.
 * This avoids unnecessary navigation history changes when already at the destination.
 */
export const goto_unless_current = async (
	path: string | URL,
	options?: Parameters<typeof goto>[1]
): Promise<void> => {
	if (page.url.pathname === path) return;
	await goto(path, options);
};

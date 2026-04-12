import type {Frontend} from '../lib/frontend.svelte.js';
import type {DiskfilePath} from '../lib/diskfile_types.js';

// TODO improve this pattern
/**
 * Applies testing-specific modifications to a Zzz instance.
 */
export const monkeypatch_zzz_for_tests = <T extends Frontend>(app: T): T => {
	// Override diskfiles.update to be synchronous.
	// In the real implementation, this would make a server request.
	// Probably want to mock differently than this but it's fine for now.
	app.diskfiles.update = (path: DiskfilePath, content: string) => {
		const diskfile = app.diskfiles.get_by_path(path);
		if (diskfile) {
			diskfile.content = content;
		}
		return Promise.resolve();
	};

	return app;
};

// Test helpers for unit tests

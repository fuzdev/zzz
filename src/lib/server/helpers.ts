import {dirname, join} from 'node:path';
import {format_file} from '@fuzdev/gro/format_file.js';

import {ScopedFs} from './scoped_fs.js';
import {ActionInputs, type ActionOutputs} from '../action_collections.js';

const ZZZ_DIR_STATE = 'state';
const ZZZ_DIR_STATE_COMPLETIONS = 'completions';

// TODO @db refactor
export const save_completion_response_to_disk = async (
	input: ActionInputs['completion_create'],
	output: ActionOutputs['completion_create'],
	zzz_dir: string,
	scoped_fs: ScopedFs,
): Promise<void> => {
	// includes `Date.now()` for sorting purposes
	const filename = `${input.completion_request.provider_name}__${Date.now()}__${input.completion_request.model}.json`; // TODO include model data in these

	const path = join(zzz_dir, ZZZ_DIR_STATE, ZZZ_DIR_STATE_COMPLETIONS, filename);

	const json = {input, output};

	await write_json(path, json, scoped_fs);
};
// TODO @db refactor
const write_json = async (path: string, json: unknown, scoped_fs: ScopedFs): Promise<void> => {
	// Check if directory exists and create it if needed
	if (!(await scoped_fs.exists(path))) {
		await scoped_fs.mkdir(dirname(path), {recursive: true});
	}

	const formatted = await format_file(JSON.stringify(json), {parser: 'json'});

	// Use ScopedFs for writing the file
	console.log('writing json', path, formatted.length);
	await scoped_fs.write_file(path, formatted);
};

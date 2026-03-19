import {z} from 'zod';

import {get_datetime_now, PathWithLeadingSlash, Uuid} from './zod_helpers.js';
import {Diskfile} from './diskfile.svelte.js';
import {DiskfileJson, DiskfilePath, type DiskfileJsonInput} from './diskfile_types.js';
import {disknode_to_diskfile_json, to_relative_path} from './diskfile_helpers.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_single_index, create_multi_index} from './indexed_collection_helpers.svelte.js';
import {DiskfilesEditor} from './diskfiles_editor.svelte.js';
import {CellJson} from './cell_types.js';
import type {ActionInputs} from './action_collections.js';

export const DiskfilesJson = CellJson.extend({
	diskfiles: z.array(DiskfileJson).default(() => []),
	selected_file_id: Uuid.nullable().default(null),
}).meta({cell_class_name: 'Diskfiles'});
export type DiskfilesJson = z.infer<typeof DiskfilesJson>;
export type DiskfilesJsonInput = z.input<typeof DiskfilesJson>;

export interface DiskfilesOptions extends CellOptions<typeof DiskfilesJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Diskfiles extends Cell<typeof DiskfilesJson> {
	readonly items: IndexedCollection<Diskfile> = new IndexedCollection({
		indexes: [
			create_single_index({
				key: 'by_path',
				extractor: (file) => file.path,
				query_schema: z.string(),
			}),

			create_multi_index({
				key: 'by_extension',
				extractor: (file) => {
					const match = /\.([^.]+)$/.exec(file.path);
					return match ? match[1]!.toLowerCase() : 'no_extension'; // guaranteed by ternary check
				},
				query_schema: z.string(),
			}),
		],
	});

	selected_file_id: Uuid | null = $state(null);

	readonly selected_file: Diskfile | null = $derived(
		this.selected_file_id ? (this.items.by_id.get(this.selected_file_id) ?? null) : null,
	);

	/** The editor for managing diskfiles editing state. */
	readonly editor: DiskfilesEditor;

	constructor(options: DiskfilesOptions) {
		super(DiskfilesJson, options);

		this.editor = new DiskfilesEditor({app: this.app});

		this.decoders = {
			diskfiles: (diskfiles) => {
				if (Array.isArray(diskfiles)) {
					this.items.clear();
					for (const diskfile_json of diskfiles) {
						this.add(diskfile_json);
					}
				}
				return HANDLED;
			},
		};

		this.init();
	}

	handle_change(params: ActionInputs['filer_change']): void {
		const validated_disknode = params.disknode;

		switch (params.change.type) {
			case 'add': {
				this.add(disknode_to_diskfile_json(validated_disknode));
				break;
			}
			case 'change': {
				const existing_diskfile = this.items.by_optional('by_path', validated_disknode.id);

				if (existing_diskfile) {
					const diskfile_json = disknode_to_diskfile_json(validated_disknode, existing_diskfile.id);

					existing_diskfile.set_json({
						...diskfile_json,
						// TODO hacky, should be handled more cleanly elsewhere
						created: existing_diskfile.created, // Preserve original creation date
						updated: get_datetime_now(), // TODO @many probably rely on the db to bump `updated`
					});
				} else {
					// If it doesn't exist yet, create a new one
					this.add(disknode_to_diskfile_json(validated_disknode));
				}
				break;
			}
			case 'delete': {
				const existing_diskfile = this.items.by_optional('by_path', validated_disknode.id);
				if (existing_diskfile) {
					this.items.remove(existing_diskfile.id);
				}
				break;
			}
		}
	}

	add(json: DiskfileJsonInput, auto_select: boolean = true): Diskfile {
		const diskfile = new Diskfile({app: this.app, json});
		this.items.add(diskfile);

		if (auto_select && this.selected_file_id === null) {
			this.select(diskfile.id);
		}

		return diskfile;
	}

	async update(path: DiskfilePath, content: string): Promise<void> {
		const result = await this.app.api.diskfile_update({path, content});
		// Handler already updated state on error
		if (!result.ok) return;
	}

	async delete(path: DiskfilePath): Promise<void> {
		const result = await this.app.api.diskfile_delete({path});
		// Handler already updated state on error
		if (!result.ok) return;
	}

	async create_file(filename: string, content: string = ''): Promise<void> {
		if (!this.app.zzz_dir) {
			throw new Error('cannot create file: zzz_dir is not set');
		}

		// TODO @many how to handle paths? need some more structure to the way they're normalized and joined
		const path = DiskfilePath.parse(`${this.app.zzz_dir}${PathWithLeadingSlash.parse(filename)}`);

		// Reuse `update` which creates or updates files
		await this.update(path, content);
	}

	async create_directory(dirname: string): Promise<void> {
		if (!this.app.zzz_dir) {
			throw new Error('cannot create directory: zzz_dir is not set');
		}

		const path = DiskfilePath.parse(`${this.app.zzz_dir}${dirname}`);

		const result = await this.app.api.directory_create({path});
		// Handler already updated state on error
		if (!result.ok) return;
	}

	get_by_path(path: DiskfilePath): Diskfile | undefined {
		return this.items.by_optional('by_path', path);
	}

	// TODO make this a derived property?
	/** The value `undefined` means uninitialized, `null` means loading, `''` means none. */
	to_relative_path(path: string): string | null | undefined {
		const {zzz_dir} = this.app;
		return zzz_dir && to_relative_path(path, zzz_dir);
	}

	/**
	 * Select a diskfile by id and also update the editor tabs.
	 * Default to the first file if `id` is `undefined`.
	 * If `id` is `null`, it selects no file.
	 * If `open_not_preview` is `true`, opens as a permanent tab, otherwise previews.
	 */
	select(id: Uuid | null | undefined, open_not_preview: boolean = false): void {
		if (id === undefined) {
			this.select_next();
		} else {
			this.selected_file_id = id;

			// Update the editor if a file is selected
			if (id !== null) {
				if (open_not_preview) {
					this.editor.open_diskfile(id);
				} else {
					this.editor.preview_diskfile(id);
				}
			}
		}
	}

	select_next(): void {
		const {by_id} = this.items;
		const next = by_id.values().next();
		this.select(next.value?.id ?? null);
	}
}

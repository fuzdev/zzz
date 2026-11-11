/**
 * The entries of libghostty-vt 1.0.0's wasm type manifest (`ghostty_type_json()`)
 * the binding reads, copied verbatim from the module `cargo xtask ghostty-vt`
 * builds — `GhosttyTerminalOption` trimmed to the options used. Lets the
 * manifest checks run without the module; `ghostty_vt.wasm.test.ts` holds this
 * copy to the real manifest.
 *
 * @module
 */

/** A fresh copy of the fixture, safe to doctor. */
export const create_ghostty_manifest_fixture = (): Record<string, any> =>
	structuredClone(GHOSTTY_MANIFEST_FIXTURE);

/** The fixture itself; never mutate it — use `create_ghostty_manifest_fixture`. */
export const GHOSTTY_MANIFEST_FIXTURE: Record<string, any> = {
	schema: 1,
	abi: {
		target: 'wasm32',
		os: 'freestanding',
		environment: 'none',
		pointer_size: 4,
		usize_size: 4,
		max_alignment: 16,
		endian: 'little'
	},
	library_version: '1.0.0',
	commit: null,
	dirty: null,
	types: {
		GhosttyResult: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_',
			values: {
				SUCCESS: 0,
				OUT_OF_MEMORY: -1,
				INVALID_VALUE: -2,
				OUT_OF_SPACE: -3,
				NO_VALUE: -4,
				IO_ERROR: -5,
				LIMIT_EXCEEDED: -6,
				REJECTED: -7,
				UNSUPPORTED: -8,
				RESULT_MAX_VALUE: 2147483647
			}
		},
		GhosttyBuildInfo: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_BUILD_INFO_',
			values: {
				INVALID: 0,
				SIMD: 1,
				KITTY_GRAPHICS: 2,
				TMUX_CONTROL_MODE: 3,
				OPTIMIZE: 4,
				VERSION_STRING: 5,
				VERSION_MAJOR: 6,
				VERSION_MINOR: 7,
				VERSION_PATCH: 8,
				VERSION_PRE: 9,
				VERSION_BUILD: 10,
				FEATURE_SNAPSHOT: 11,
				FEATURE_FORMATTER: 12,
				FEATURE_SELECTION: 13,
				FEATURE_SEARCH: 14,
				FEATURE_RENDER_STATE: 15,
				FEATURE_INPUT_ENCODE: 16,
				FEATURE_COLOR: 17,
				FEATURE_GRID_INTROSPECTION: 18,
				FEATURE_GLYPH_PROTOCOL: 19,
				MAX_VALUE: 2147483647
			},
			keys: {
				SIMD: {
					direction: 'out',
					type: 'bool'
				},
				KITTY_GRAPHICS: {
					direction: 'out',
					type: 'bool'
				},
				TMUX_CONTROL_MODE: {
					direction: 'out',
					type: 'bool'
				},
				OPTIMIZE: {
					direction: 'out',
					type: 'GhosttyOptimizeMode'
				},
				VERSION_STRING: {
					direction: 'out',
					type: 'GhosttyString'
				},
				VERSION_MAJOR: {
					direction: 'out',
					type: 'u32'
				},
				VERSION_MINOR: {
					direction: 'out',
					type: 'u32'
				},
				VERSION_PATCH: {
					direction: 'out',
					type: 'u32'
				},
				VERSION_PRE: {
					direction: 'out',
					type: 'GhosttyString'
				},
				VERSION_BUILD: {
					direction: 'out',
					type: 'GhosttyString'
				},
				FEATURE_SNAPSHOT: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_FORMATTER: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_SELECTION: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_SEARCH: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_RENDER_STATE: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_INPUT_ENCODE: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_COLOR: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_GRID_INTROSPECTION: {
					direction: 'out',
					type: 'bool'
				},
				FEATURE_GLYPH_PROTOCOL: {
					direction: 'out',
					type: 'bool'
				}
			}
		},
		GhosttyOptimizeMode: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_OPTIMIZE_',
			values: {
				DEBUG: 0,
				RELEASE_SAFE: 1,
				RELEASE_SMALL: 2,
				RELEASE_FAST: 3,
				MODE_MAX_VALUE: 2147483647
			}
		},
		GhosttyString: {
			kind: 'struct',
			size: 8,
			align: 4,
			fields: {
				ptr: {
					offset: 0,
					size: 4,
					type: 'pointer',
					elem: 'u8',
					const: true
				},
				len: {
					offset: 4,
					size: 4,
					type: 'u32'
				}
			}
		},
		GhosttyTerminalOption: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_TERMINAL_OPT_',
			values: {
				INVALID: 0,
				WRITE_PTY: 2,
				SCROLLBACK_MAX_BYTES: 28,
				SCROLLBACK_MAX_LINES: 29,
				MAX_VALUE: 2147483647
			},
			keys: {
				WRITE_PTY: {
					direction: 'in',
					type: 'GhosttyTerminalWritePtyFn'
				},
				SCROLLBACK_MAX_BYTES: {
					direction: 'in',
					type: 'u32'
				},
				SCROLLBACK_MAX_LINES: {
					direction: 'in',
					type: 'u32'
				}
			}
		},
		GhosttyFormatterOption: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_FORMATTER_OPT_',
			values: {
				INVALID: 0,
				EMIT: 1,
				UNWRAP: 2,
				TRIM: 3,
				SELECTION: 4,
				EXTRAS: 5,
				MAX_VALUE: 2147483647
			},
			keys: {
				EMIT: {
					direction: 'in',
					type: 'GhosttyFormatterFormat'
				},
				UNWRAP: {
					direction: 'in',
					type: 'bool'
				},
				TRIM: {
					direction: 'in',
					type: 'bool'
				},
				SELECTION: {
					direction: 'in',
					type: 'GhosttySelection'
				},
				EXTRAS: {
					direction: 'in',
					type: 'GhosttyFormatterExtras'
				}
			}
		},
		GhosttyFormatterFormat: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_FORMATTER_FORMAT_',
			values: {
				PLAIN: 0,
				VT: 1,
				HTML: 2,
				MAX_VALUE: 2147483647
			}
		}
	}
};

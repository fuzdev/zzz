/**
 * The entries of libghostty-vt 1.0.0's wasm type manifest (`ghostty_type_json()`)
 * the binding reads, copied verbatim from the module `cargo xtask ghostty-vt`
 * builds — the key enums trimmed to the keys used (`GhosttyKey` is whole,
 * for the keyboard mapping's completeness check). Lets the
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
		GhosttyKey: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_KEY_',
			values: {
				UNIDENTIFIED: 0,
				BACKQUOTE: 1,
				BACKSLASH: 2,
				BRACKET_LEFT: 3,
				BRACKET_RIGHT: 4,
				COMMA: 5,
				DIGIT_0: 6,
				DIGIT_1: 7,
				DIGIT_2: 8,
				DIGIT_3: 9,
				DIGIT_4: 10,
				DIGIT_5: 11,
				DIGIT_6: 12,
				DIGIT_7: 13,
				DIGIT_8: 14,
				DIGIT_9: 15,
				EQUAL: 16,
				INTL_BACKSLASH: 17,
				INTL_RO: 18,
				INTL_YEN: 19,
				A: 20,
				B: 21,
				C: 22,
				D: 23,
				E: 24,
				F: 25,
				G: 26,
				H: 27,
				I: 28,
				J: 29,
				K: 30,
				L: 31,
				M: 32,
				N: 33,
				O: 34,
				P: 35,
				Q: 36,
				R: 37,
				S: 38,
				T: 39,
				U: 40,
				V: 41,
				W: 42,
				X: 43,
				Y: 44,
				Z: 45,
				MINUS: 46,
				PERIOD: 47,
				QUOTE: 48,
				SEMICOLON: 49,
				SLASH: 50,
				ALT_LEFT: 51,
				ALT_RIGHT: 52,
				BACKSPACE: 53,
				CAPS_LOCK: 54,
				CONTEXT_MENU: 55,
				CONTROL_LEFT: 56,
				CONTROL_RIGHT: 57,
				ENTER: 58,
				META_LEFT: 59,
				META_RIGHT: 60,
				SHIFT_LEFT: 61,
				SHIFT_RIGHT: 62,
				SPACE: 63,
				TAB: 64,
				CONVERT: 65,
				KANA_MODE: 66,
				NON_CONVERT: 67,
				DELETE: 68,
				END: 69,
				HELP: 70,
				HOME: 71,
				INSERT: 72,
				PAGE_DOWN: 73,
				PAGE_UP: 74,
				ARROW_DOWN: 75,
				ARROW_LEFT: 76,
				ARROW_RIGHT: 77,
				ARROW_UP: 78,
				NUM_LOCK: 79,
				NUMPAD_0: 80,
				NUMPAD_1: 81,
				NUMPAD_2: 82,
				NUMPAD_3: 83,
				NUMPAD_4: 84,
				NUMPAD_5: 85,
				NUMPAD_6: 86,
				NUMPAD_7: 87,
				NUMPAD_8: 88,
				NUMPAD_9: 89,
				NUMPAD_ADD: 90,
				NUMPAD_BACKSPACE: 91,
				NUMPAD_CLEAR: 92,
				NUMPAD_CLEAR_ENTRY: 93,
				NUMPAD_COMMA: 94,
				NUMPAD_DECIMAL: 95,
				NUMPAD_DIVIDE: 96,
				NUMPAD_ENTER: 97,
				NUMPAD_EQUAL: 98,
				NUMPAD_MEMORY_ADD: 99,
				NUMPAD_MEMORY_CLEAR: 100,
				NUMPAD_MEMORY_RECALL: 101,
				NUMPAD_MEMORY_STORE: 102,
				NUMPAD_MEMORY_SUBTRACT: 103,
				NUMPAD_MULTIPLY: 104,
				NUMPAD_PAREN_LEFT: 105,
				NUMPAD_PAREN_RIGHT: 106,
				NUMPAD_SUBTRACT: 107,
				NUMPAD_SEPARATOR: 108,
				NUMPAD_UP: 109,
				NUMPAD_DOWN: 110,
				NUMPAD_RIGHT: 111,
				NUMPAD_LEFT: 112,
				NUMPAD_BEGIN: 113,
				NUMPAD_HOME: 114,
				NUMPAD_END: 115,
				NUMPAD_INSERT: 116,
				NUMPAD_DELETE: 117,
				NUMPAD_PAGE_UP: 118,
				NUMPAD_PAGE_DOWN: 119,
				ESCAPE: 120,
				F1: 121,
				F2: 122,
				F3: 123,
				F4: 124,
				F5: 125,
				F6: 126,
				F7: 127,
				F8: 128,
				F9: 129,
				F10: 130,
				F11: 131,
				F12: 132,
				F13: 133,
				F14: 134,
				F15: 135,
				F16: 136,
				F17: 137,
				F18: 138,
				F19: 139,
				F20: 140,
				F21: 141,
				F22: 142,
				F23: 143,
				F24: 144,
				F25: 145,
				FN: 146,
				FN_LOCK: 147,
				PRINT_SCREEN: 148,
				SCROLL_LOCK: 149,
				PAUSE: 150,
				BROWSER_BACK: 151,
				BROWSER_FAVORITES: 152,
				BROWSER_FORWARD: 153,
				BROWSER_HOME: 154,
				BROWSER_REFRESH: 155,
				BROWSER_SEARCH: 156,
				BROWSER_STOP: 157,
				EJECT: 158,
				LAUNCH_APP_1: 159,
				LAUNCH_APP_2: 160,
				LAUNCH_MAIL: 161,
				MEDIA_PLAY_PAUSE: 162,
				MEDIA_SELECT: 163,
				MEDIA_STOP: 164,
				MEDIA_TRACK_NEXT: 165,
				MEDIA_TRACK_PREVIOUS: 166,
				POWER: 167,
				SLEEP: 168,
				AUDIO_VOLUME_DOWN: 169,
				AUDIO_VOLUME_MUTE: 170,
				AUDIO_VOLUME_UP: 171,
				WAKE_UP: 172,
				COPY: 173,
				CUT: 174,
				PASTE: 175,
				MAX_VALUE: 2147483647
			}
		},
		GhosttyKeyAction: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_KEY_ACTION_',
			values: {
				RELEASE: 0,
				PRESS: 1,
				REPEAT: 2,
				MAX_VALUE: 2147483647
			}
		},
		GhosttyKittyKeyFlags: {
			kind: 'alias',
			size: 1,
			align: 1,
			type: 'u8'
		},
		GhosttyMods: {
			kind: 'alias',
			size: 2,
			align: 2,
			type: 'u16'
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
				BELL: 3,
				TITLE_CHANGED: 6,
				PWD_CHANGED: 26,
				SCROLLBACK_MAX_BYTES: 28,
				SCROLLBACK_MAX_LINES: 29,
				RENDER_HOLD: 42,
				MAX_VALUE: 2147483647
			},
			keys: {
				WRITE_PTY: {
					direction: 'in',
					type: 'GhosttyTerminalWritePtyFn'
				},
				BELL: {
					direction: 'in',
					type: 'GhosttyTerminalBellFn'
				},
				TITLE_CHANGED: {
					direction: 'in',
					type: 'GhosttyTerminalTitleChangedFn'
				},
				PWD_CHANGED: {
					direction: 'in',
					type: 'GhosttyTerminalPwdChangedFn'
				},
				SCROLLBACK_MAX_BYTES: {
					direction: 'in',
					type: 'u32'
				},
				SCROLLBACK_MAX_LINES: {
					direction: 'in',
					type: 'u32'
				},
				RENDER_HOLD: {
					direction: 'in',
					type: 'GhosttyTerminalRenderHoldFn'
				}
			}
		},
		GhosttyTerminalData: {
			kind: 'enum',
			size: 4,
			align: 4,
			underlying: 'i32',
			prefix: 'GHOSTTY_TERMINAL_DATA_',
			values: {
				INVALID: 0,
				KITTY_KEYBOARD_FLAGS: 8,
				TITLE: 12,
				PWD: 13,
				MAX_VALUE: 2147483647
			},
			keys: {
				KITTY_KEYBOARD_FLAGS: {
					direction: 'out',
					type: 'GhosttyKittyKeyFlags'
				},
				TITLE: {
					direction: 'out',
					type: 'GhosttyString'
				},
				PWD: {
					direction: 'out',
					type: 'GhosttyString'
				}
			}
		},
		GhosttyTerminal: {
			kind: 'opaque',
			size: 4,
			align: 4
		},
		GhosttyTerminalWritePtyFn: {
			kind: 'callback',
			size: 4,
			align: 4,
			params: [
				{ type: 'GhosttyTerminal' },
				{ type: 'pointer', elem: 'opaque', const: false, nullable: true },
				{ type: 'pointer', elem: 'u8', const: true },
				{ type: 'u32' }
			],
			return: { type: 'void' }
		},
		GhosttyTerminalBellFn: {
			kind: 'callback',
			size: 4,
			align: 4,
			params: [
				{ type: 'GhosttyTerminal' },
				{ type: 'pointer', elem: 'opaque', const: false, nullable: true }
			],
			return: { type: 'void' }
		},
		GhosttyTerminalTitleChangedFn: {
			kind: 'callback',
			size: 4,
			align: 4,
			params: [
				{ type: 'GhosttyTerminal' },
				{ type: 'pointer', elem: 'opaque', const: false, nullable: true }
			],
			return: { type: 'void' }
		},
		GhosttyTerminalPwdChangedFn: {
			kind: 'callback',
			size: 4,
			align: 4,
			params: [
				{ type: 'GhosttyTerminal' },
				{ type: 'pointer', elem: 'opaque', const: false, nullable: true }
			],
			return: { type: 'void' }
		},
		GhosttyTerminalRenderHoldFn: {
			kind: 'callback',
			size: 4,
			align: 4,
			params: [
				{ type: 'GhosttyTerminal' },
				{ type: 'pointer', elem: 'opaque', const: false, nullable: true },
				{ type: 'bool' }
			],
			return: { type: 'void' }
		},
		GhosttyCell: {
			kind: 'packed',
			size: 8,
			align: 8,
			underlying: 'u64',
			bits: {
				content_tag: { lsb: 0, width: 2, type: 'GhosttyCellContentTag' },
				content: {
					lsb: 2,
					width: 24,
					kind: 'union',
					tag: 'content_tag',
					arms: {
						CODEPOINT: {
							kind: 'packed',
							width: 24,
							bits: { codepoint: { lsb: 0, width: 21, type: 'u21' } }
						},
						CODEPOINT_GRAPHEME: {
							kind: 'packed',
							width: 24,
							bits: { codepoint: { lsb: 0, width: 21, type: 'u21' } }
						},
						BG_COLOR_PALETTE: {
							kind: 'packed',
							width: 24,
							bits: { index: { lsb: 0, width: 8, type: 'GhosttyColorPaletteIndex' } }
						},
						BG_COLOR_RGB: {
							kind: 'packed',
							width: 24,
							bits: {
								r: { lsb: 0, width: 8, type: 'u8' },
								g: { lsb: 8, width: 8, type: 'u8' },
								b: { lsb: 16, width: 8, type: 'u8' }
							}
						}
					}
				},
				style_id: { lsb: 26, width: 16, type: 'GhosttyStyleId' },
				wide: { lsb: 42, width: 2, type: 'GhosttyCellWide' },
				protected: { lsb: 44, width: 1, type: 'bool' },
				hyperlink: { lsb: 45, width: 1, type: 'bool' },
				semantic_content: { lsb: 46, width: 2, type: 'GhosttyCellSemanticContent' }
			}
		},
		GhosttyStyleColorValue: {
			kind: 'union',
			size: 3,
			align: 1,
			fields: {
				palette: { offset: 0, size: 1, type: 'GhosttyColorPaletteIndex' },
				rgb: { offset: 0, size: 3, type: 'GhosttyColorRgb' }
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

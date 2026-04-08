import type {ActionMethod} from './action_metatypes.js';
import type {ActionKind} from '@fuzdev/fuz_app/actions/action_spec.js';

export const GLYPH_UNKNOWN = '⁇'; // ⍰
export const GLYPH_IMPORTANT = '⁈';
export const GLYPH_INFO = 'ⓘ';

export const GLYPH_ADD = '✛'; // + ✚ ✛ ✜
export const GLYPH_REMOVE = '🗙'; //
export const GLYPH_DELETE = '⌧'; // 🗑 ⨉ ✕ 🗙 ⤫ ⤬ ✖ ⌧ ⨂ ⊝
export const GLYPH_CLEAR = '⌫';
export const GLYPH_RESTORE = '⤻';
export const GLYPH_CANCEL = '⦸';
export const GLYPH_DRAG = '≡'; // ≡ ☰ ☷
export const GLYPH_COPY = '⧉';
export const GLYPH_PASTE = '⎌'; // ⧈ ⎗ ⎘ ⎙
export const GLYPH_RESET = '⤺';
export const GLYPH_REFRESH = '⟳'; // ↻ ⟳
export const GLYPH_CONNECT = '⭍'; // ⨁
export const GLYPH_DISCONNECT = '⊝';
export const GLYPH_RETRY = '↺'; // ⟲'; // ⟲ ⟳ ⤾ ⤼ ↻
export const GLYPH_PLACEHOLDER = '↳';
export const GLYPH_SEND = '⮥'; // ⮥ ⭷ ↗
export const GLYPH_PLAY = '▶︎';
export const GLYPH_PAUSE = '❙❙'; // is 2 chars, should be supported by usage
// export const GLYPH_STOP = '⏹'; // ⏹ ■ ▣ ▪
// export const GLYPH_EJECT = '⏏';
//  ⏭ ⏯ ⏮

export const GLYPH_CHECKMARK = '✓';
export const GLYPH_XMARK = '✗';
export const GLYPH_XMARK_HEAVY = '✘';

export const GLYPH_DOWNLOAD = '⭳'; // ⭳ ⥥ ⤓ ⇩
export const GLYPH_ERROR = '‼'; // ⨂ ⁉ ‼ ‽ ⸮ ⸘ ⚠
export const GLYPH_CHEVRON_UP = '⮝'; // ⮝ ⯅ ˄ ∧ ⌃ ▴ ▵ ▲
export const GLYPH_CHEVRON_RIGHT = '⮞'; // ⮞ ❯ ▸ ⭢ ›
export const GLYPH_CHEVRON_DOWN = '⮟'; // ⮟ ⌄ ˅ ∨
export const GLYPH_CHEVRON_LEFT = '⮜'; // ⮜ ⯇ ˂ ‹ ◁ ▹ ◂ ◃ ◀
export const GLYPH_DOUBLE_CHEVRON_LEFT = '«'; // « ⪡ ⪛ ⟪ ⟨ ≪ ⯇ ⭠ ⇇ ⇚ ⇦
export const GLYPH_DOUBLE_CHEVRON_RIGHT = '»'; // » ⪢ ⪜ ⟫ ⟩ ≫ ⯈ ⭢ ⇉ ⇛ ⇨

// ⤉ ⤈ ⤣ ⤤ ⤥ ⤦

export const GLYPH_EDIT = '✎'; // ✎ ✏ ✐ ✑ ✒
// export const GLYPH_MOVE = '⧈';
// ⊞ ⧉ ⧈
// ⎗ ⎗ ⎘ ⌖ ⌶ ⎙
// ⎘ ⎘ ⎌ ⌫ ⊘ ⦸
// ⤺ ⤻ ⤼ ⤽ ⤾ ⤿
export const GLYPH_SORT = '⇅'; // ⇅ ⇵ ⮃ ⮁

export const GLYPH_BACKEND = '🜢';
export const GLYPH_CHAT = '⌸';
export const GLYPH_THREAD = '☷';
export const GLYPH_TURN = '⎍'; // ⎎ ⎍
export const GLYPH_FILE = '⧈'; // ⏚ ⧈ ⊞ ⌺ ▤
// TODO looks too much like chat
export const GLYPH_LIST = '▤';
export const GLYPH_DIRECTORY = '▦'; // 🗁 ▦ ▥ 🗀
export const GLYPH_CREATE_FILE = '🗎';
export const GLYPH_CREATE_FOLDER = '🗁';
export const GLYPH_PROMPT = '⌇'; // ⌇ ⍋  ⌭
// TODO idk about this one, is maybe better suited for list?
export const GLYPH_PART = '┊'; //  ┊ ┋ ╎ ╏
export const GLYPH_PROVIDER = '⨕';
export const GLYPH_MODEL = '⊛'; // ⨹ ⨺ ⊛
export const GLYPH_ACTION = '⍾';
export const GLYPH_VIEW = '⍜'; // ⦿ ⦾ ⦽ ⦼
export const GLYPH_PREVIEW = '⦾'; // ⦾
export const GLYPH_LOG = '⎙'; // ⎙ ⏚ ⌺ ⍜
export const GLYPH_TAB = '⛶';
export const GLYPH_PROJECT = '⌬';
export const GLYPH_CAPABILITY = '⧰'; // ⌁
export const GLYPH_SETTINGS = '⛮'; // ⛭  ⚙  ⛮  ⛯ ⛣
export const GLYPH_DOMAIN = '⟡'; // ⟡ ⏥
export const GLYPH_PAGE = '⌺'; // ⌺ ⎚

export const GLYPH_SPACE = '⌂'; // space/container
export const GLYPH_DESK = '⍟'; // desk/system menu
export const GLYPH_PIN = '⏍'; // pin/tack

export const GLYPH_TERMINAL = '⌨'; // ⌨ ⍄ ⎙
export const GLYPH_WORKSPACE = '⊞'; // ⌗ ⊟ ⊞
export const GLYPH_IDEA = '⌆'; // TODO use

export const GLYPH_PING = '⥀';
export const GLYPH_HEARTBEAT = '∽'; // ∿ ≋ 〰 ∽ ~
export const GLYPH_RESPONSE = '⮑';
export const GLYPH_SESSION = '⏣';

export const GLYPH_ACTION_TYPE_LOCAL_CALL = '⤳'; // ⤤ ⤳
export const GLYPH_ACTION_TYPE_REMOTE_NOTIFICATION = '⥙'; // ⤷
export const GLYPH_ACTION_TYPE_REQUEST_RESPONSE = '⥮'; // ⤨ ⥮ ⥯

export const GLYPH_EXTERNAL_LINK = '🡵';

export const GLYPH_ARROW_RIGHT = '→'; // → ➝ ➞ ➜ ➡ ⟶ ⭢ ⤷ ⤳ ⥅ ⮕ ⭆ ⭆ ⭈ ⤞ ⤠
export const GLYPH_ARROW_LEFT = '←'; // ← ⭠

export const get_glyph_for_action_method = (method: ActionMethod): string => {
	switch (method) {
		case 'ping':
			return GLYPH_PING;
		case 'completion_create':
			return GLYPH_RESPONSE;
		case 'session_load':
			return GLYPH_SESSION;
		case 'diskfile_update':
		case 'diskfile_delete':
		case 'filer_change':
			return GLYPH_FILE;
		default:
			return GLYPH_ACTION;
	}
};

export const get_glyph_for_action_kind = (kind: ActionKind): string => {
	switch (kind) {
		case 'local_call':
			return GLYPH_ACTION_TYPE_LOCAL_CALL;
		case 'request_response':
			return GLYPH_ACTION_TYPE_REQUEST_RESPONSE;
		case 'remote_notification':
			return GLYPH_ACTION_TYPE_REMOTE_NOTIFICATION;
		default:
			return GLYPH_ACTION;
	}
};

// ⭍ ⏻
//⥘ ⥙ ⇅ ⇵ ⇳ ⇊ ⇈  ⮃
// ⬎⤣

// ↗ ⤴ ⤊ ⥘ ⭡ ⭧ ⥉ ↱ ⤐ ⤏ ⥟ ⤞ ⤟ ⤠ ⎋ ⧉ ⬈ ⌁ ⍙ ⎗ ⍏ ⍟ ⍝ ⏏ ⎄ ↑ ⇧ ⮕ ⮝ ⤈ ⥁ ⥅ ⥇ ⥓ ⥖ ⥗ ⥚ ⥛ ⤊ ⤉ ⤒
// ⇗ ⤈ ⤉ ⤒ ⥈ ⥑ ⥒ ⥔ ⥕ ⥙ ⥛ ⭦ ⭧ ⭨ ⭩ ⯁ ⯅ ⯇ ⯈ ⯊ ⯋ ⯏ ⯑ ⯓ ⯕ ⯗ ⯙ ⯛ ⯝ ⯟
// ⇪ ⮊ ⮌ ⮎ ⮐ ⮒ ⮓ ⮕ ⮗ ⮙ ⮛ ⮝ ⮟ ⮡ ⮣ ⮥ ⮧ ⮩ ⮫ ⮭ ⮯ ⮱ ⮳ ⮵ ⮷ ⮹ ⮻ ⮽ ⮿ ⯁ ⯃ ⯅
// ⯇ ⯈ ⯊ ⯌ ⯎ ⯐ ⯒ ⯔ ⯖ ⯘ ⯚ ⯜ ⯞ ⯠ ⯢ ⯤ ⯦ ⯨ ⯪ ⯬ ⯮ ⯰ ⯲ ⯴ ⯶ ⯸ ⯺ ⯼ ⯾ Ⰰ Ⰱ
// Ⰲ Ⰳ Ⰴ Ⰵ Ⰶ Ⰷ Ⰸ Ⰹ Ⰺ Ⰻ Ⰼ Ⰽ Ⰾ Ⰿ Ⱀ Ⱁ Ⱂ Ⱃ Ⱄ Ⱅ Ⱆ Ⱇ Ⱈ Ⱉ Ⱊ Ⱋ Ⱌ Ⱍ Ⱎ Ⱏ
// Ⱐ Ⱑ Ⱒ Ⱓ Ⱔ Ⱕ Ⱖ Ⱗ Ⱘ Ⱙ Ⱚ Ⱛ Ⱜ Ⱝ Ⱞ Ⱟ ⰰ ⰱ ⰲ ⰳ ⰴ ⰵ ⰶ ⰷ ⰸ ⰹ ⰺ ⰻ ⰼ ⰽ ⰾ ⰿ
// ⱀ ⱁ ⱂ ⱃ ⱄ ⱅ ⱆ ⱇ ⱈ ⱉ ⱊ ⱋ ⱌ ⱍ ⱎ ⱏ ⱐ ⱑ ⱒ ⱓ ⱔ ⱕ ⱖ ⱗ ⱘ ⱙ ⱚ ⱛ ⱜ ⱝ ⱞ ⱟ

// ⎗ ⎘

// ⊞
// ⊟
// ⍈
// ⟁
// ⍟ ✴ ✧

// ⇇ ⇉  maybe use these for deps?

// ⛶
// ⏛
// ☳ ☷
// ≣
// ⠿
// TODO GLYPH_THREAD
// ⧛

// ⚟

// ⌬ ⬡ ⬢ ⏣

// ⍝

// 🜢

// ⨖

// ⌾
// ⌓
// ⍜
// ⍖
// ⍤

// ⍾

// ⌯
// ⌗
// ⎍

// ⨳

// ⎕
// ⌘

// ⌥
// ⌤

// ⏀
// ⏁

// ⎎
// 🗎  🗏  🗀  🗁  🗂  🗃  🗄  ❏  ❐  ▣  ▢  □  ⧉  ⧈

// ·
// •
// ․
// ‥
// …
// ⋮
// ⋯
// ⋰
// ⋱
// ⁚
// ⁝
// ⁘
// ⁙
// ⁖
// ⁛
// ⁞
// ⸪
// ⸫
// ⸬
// ⋗
// ∴
// ∵
// ∷
// ⁂
// ⨀
// ⁜
// ․
// ⠂
// ⠃
// ⠒
// ⠤
// ⋄
// ⨪
// ⨯
// ⦙
// ∙
// ⦁
// ◦
// ◉
// ◌
// ◍
// ◎
// ⊙
// ⨁
// ⊚
// ◌̣
// ◌̇
// ⊓̇
// ∴
// ⟐
// ⋮
// ⸭
// ⟇
// ⏏
// ⌑
// ⍩
// ⌂
// ⌘
// ▄
// ▪

// ⭉ ⭊ ⤟⮭ ⎋

// —
// –

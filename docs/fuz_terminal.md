# fuz_terminal

zzz's terminal view: libghostty-vt (Ghostty's emulator, built to wasm) under
a DOM renderer and input layer of zzz's own, in `src/lib/fuz_terminal/`. How
terminals run — the `Terminal` cell, PTYs, output pacing — is
./architecture.md § Terminals.

## Modules

`src/lib/fuz_terminal/` binds libghostty-vt's wasm build — Ghostty's
emulator: parsing, the screens, scrollback with reflow — and draws it with
`FuzTerminal.svelte`, a DOM renderer of zzz's own, which zzz's terminal views
host (see [Terminals](./architecture.md#terminals)). The binding has no DOM or Svelte
dependency, so its behavior is tested in Node:

- `ghostty_vt.ts` — `load_ghostty_vt` and `GhosttyVt`: the instance (its
  function exports guarded against an escaping exception, below), its
  validated type manifest, its build info (version, compiled-in features),
  and `check` for result codes. The core resolves its constants at load
  (`GhosttyVt.constants`); each other module resolves its own once, on first
  use (`GhosttyVt.resolve`), so enum values and offsets are never hardcoded.
  `load_ghostty_vt` takes the module's bytes, a fetch `Response`, or a
  compiled module from its caller — the binding never fetches an app path —
  and refuses (`GhosttyLoadError`) bytes that don't compile, a module that
  imports anything, or one that isn't libghostty-vt. A manifest entry
  that's missing or reshaped throws `GhosttyManifestError` naming it; every
  `GhosttyResult` is checked, a failure thrown as `GhosttyResultError` with
  the export and the result's name.
- `ghostty_terminal.ts` — `GhosttyTerminal`: write (bytes or a string),
  resize (reflowing the primary screen), plain-text format (`format_text`:
  the active screen with its scrollback, trimmed, soft wraps unwrapped),
  paste encoding, effects, and an idempotent `dispose`, after which every
  use throws `GhosttyDisposedError`. A query in the output gets a reply
  only through a registered `write_pty` handler. Width and height are
  capped at `GHOSTTY_TERMINAL_MAX_SIZE` cells: the screen is allocated up
  front and wasm memory never shrinks, so an absurd size (a bad cell
  measurement) is refused before it can grow memory by gigabytes. Writes
  go through a per-terminal buffer kept between writes. A terminal can be
  created with modes set, each as its reset default too (`modes`).
- `fuz_terminal_module.ts` (beside the library, in `src/lib/`, since it knows
  the app's asset path) — `load_fuz_terminal_module`: the page's one fetch
  and compile of the module, for every view (see [Terminals](./architecture.md#terminals)).
- `ghostty_memory.ts` — linear memory: views cached until memory grows,
  never held across an export call; scratch and opaque-slot allocations
  freed on every path. Buffers the library allocates
  (the formatter's output) are freed with `ghostty_free`.
- `ghostty_render_frame.ts` — the frame data's types (`GhosttyRenderRow`,
  `GhosttyRenderRun`, `GhosttyRenderStyle`, `GhosttyRenderCursor`,
  `GhosttyRenderColors`, …) and `GHOSTTY_RENDER_DEFAULT_STYLE`: the plain,
  immutable values a renderer draws from, with no dependency on the reader.
- `ghostty_render_state.ts` — `GhosttyRenderState`: the render-state
  reader, turning the library's per-frame copy of the screen into that
  frame data (below). Its terminal disposes it first.
- `ghostty_key_encoder.ts` — `GhosttyKeyEncoder`: key events to the bytes
  a program expects, following the terminal's input modes (below). Its
  terminal disposes it first.
- `ghostty_paste.ts` — the paste safety rule (`get_ghostty_paste_hazard`),
  the encoded length (`to_ghostty_paste_length`), and the encoder's
  constants, under `GhosttyTerminal.encode_paste` (§ Paste, below).
- `ghostty_effects.ts` — the effects the binding registers (`write_pty`,
  `bell`, `title_changed`, `pwd_changed`, `render_hold`), their handler
  types, their constants and callback signatures from the manifest, and
  `GhosttyEffectRouter`, which dispatches each callback by terminal handle.
- `ghostty_callback_table.ts`, `wasm_trampoline.ts` — `GhosttyCallbackTable`:
  function-table slots holding JS callbacks, each added once and kept for
  the instance's life;
  a trampoline is a tiny wasm module, encoded and compiled at runtime,
  that wraps a JS function as a wasm one (a table slot takes only those).
- `ghostty_manifest.ts`, `ghostty_errors.ts` — the manifest reader (enum
  values, struct layouts, and the bit positions of packed types such as
  `GhosttyCell`, which aren't ABI) and the binding's errors.

The renderer, beside it (tested under jsdom with the built module):

- `FuzTerminal.svelte` — the view: the root element, the keyed rows, the
  cursor, a cell probe, and a plain-text message for a failure.
- `fuz_terminal_state.svelte.ts` — `FuzTerminalState`: the view's instance,
  terminal, and reader, the frame loop, render holds, sizing, and errors;
  `FuzTerminalOptions` is the host's side (the component's props).
- `fuz_terminal_keyboard.ts` — a `KeyboardEvent` to a `GhosttyKeyInput`
  (the key from `code`, the modifiers, the text, the unshifted code point),
  and which keys the browser and the OS keep.
- `fuz_terminal_key_target.ts` — whether a key event's target is a view
  that takes keys, for a page's global shortcuts; apart from the keyboard
  module, so every page's shortcuts load none of the key encoding.
- `fuz_terminal_style.ts` — styles and colors to CSS: a style's declarations
  (cached by key), and the root's color custom properties for a frame.
- `fuz_terminal_layout.ts` — the size in cells from a measurement, a row's
  runs split for boxing, and the cursor's box.
- `fuz_terminal_frame.ts` — `FuzTerminalFrameLoop`, at most one frame
  pending.
- `fuz_terminal_deps.ts` — `FuzTerminalDeps` (loading, frames, a timer,
  resize observation, measuring, the keyboard platform), the browser's
  defaults, and the context a test sets its own through.

## Effects

A program's output asks the terminal for things it can't do
itself — answer a query, ring the bell, retitle the window. libghostty-vt
hands each to a callback the host registers (`GhosttyTerminal.set_effect`,
which replaces a handler, or clears it with `null`): `write_pty` gets a
reply for the PTY as a copied `Uint8Array`, `bell` fires, and
`title_changed` and `pwd_changed` are handed the new string, read from the
terminal inside the callback. The library ignores an effect when no
handler is registered: a cursor-position or device-attributes query
gets no reply, and none arrives later. That's what lets a history be fed
into a fresh terminal without answering its stale queries — feed it with no
`write_pty` registered, then register one for the live output. What the
history does to the terminal's state still carries forward, as it should
when the live stream continues it: a history that turned on the in-band
size report (mode 2048) makes the first resize after registering send a
report, and a history that ends partway through a query is answered when
the live output completes it.

```
write(bytes) ─ busy ─ ghostty_terminal_vt_write ── parser hits ESC[6n
                                                       │ call_indirect(slot)
                       trampoline (table slot, one per effect per instance)
                                                       │ (terminal, userdata, ptr, len)
                       GhosttyEffectRouter ── by terminal handle ──▶ the terminal's receiver
                                                       │ copy the bytes, call the handler
                                                       │ (a throw is kept, never rethrown here)
           ◀── vt_write returns ── rest of the output parsed ──┘
       idle; a kept handler exception is thrown now, as GhosttyEffectError
```

The rules follow from callbacks running in the middle of the library's
parse: a handler can read the terminal but not write, resize, dispose, or
re-register it (`GhosttyReentrancyError`); the data it's passed is borrowed,
so the binding copies or decodes it before the handler sees it; it may write
other terminals; its return value is ignored, so an async handler catches
its own errors. Handlers run synchronously inside `write` and `resize`; a
handler's exception is caught inside the callback, and the call finishes
and then throws `GhosttyEffectError` with the first exception as its `cause`.
The callback slots are bounded: one per effect per module instance
(`GhosttyCallbackTable`), added on first registration and never released,
since a wasm table can't shrink, and `GhosttyEffectRouter` dispatches each
by the terminal handle the library passes to the terminal attached under
it — so the table grows by one slot per effect however many terminals come
and go. A terminal detaches from the router before its handle is freed.
The library's other effects aren't bound and are never
registered; the clipboard ones stay that way until there's a way to ask the
person first. The trampolines are compiled at runtime, so a page
Content-Security-Policy would have to allow wasm compilation
(`'wasm-unsafe-eval'`) — which loading the module needs anyway.

## Poisoning

A handler's exception is caught inside the callback and
surfaced after the call. One can still escape a call into the module: a
trap, or the JS stack running out inside the module's frames or at the
callback boundary, before the catch is reached. Unwinding through wasm
skips the frames' epilogues, so the stack pointer the module keeps in
linear memory stays moved (enough escapes and an ordinary call traps), the
write it abandoned left that terminal mid-parse, and it may have landed
mid-allocation in the heap every terminal on the instance shares. Rather
than guess at what survived, `GhosttyVt` wraps each function export once at
load, and the first escape poisons the instance — later modules' calls
included, with nothing to opt into:

- The exception reaches the caller of the call it escaped from, unchanged:
  the cleanup on its way out (scratch frees, the formatter's output)
  skips its own calls into the module rather than have them refused.
- Every later call throws `GhosttyPoisonedError`, with the escape as its
  `cause`, before entering wasm. `GhosttyVt.poisoned` records the export
  it escaped from and the exception.
- A `write` or `resize` during which a nested call poisoned the instance —
  a handler's own call, or its write to another terminal — throws
  `GhosttyPoisonedError` once it returns, and that wins over any handler
  exception. Once poisoned, no handler runs for the rest of the parse.
- Poison belongs to the module instance, not the `GhosttyVt` object: every
  wrapper of one instance sees it, and other instances don't.
- A stack overflow at a call's very entry poisons too, though it disturbed
  nothing: the guard can't tell it from one that did.

A poisoned instance's terminals dispose without calling in, and its memory
goes when it's collected; a host builds a fresh instance from the compiled
module. The guard costs a few nanoseconds a call.

## Rendering data

libghostty-vt's render state is a copy of what one
frame needs, updated in place from the terminal — it redoes only what
changed — with two layers of change tracking: the frame's (clean, partial,
full) and a flag per row. An update only adds to them; the renderer clears
both once it has drawn (`ghostty_render_state_clean`). `GhosttyRenderState`
— refused with `GhosttyLoadError` for a module built without the
`render_state` feature — reads it into JS once per update and keeps
nothing of wasm memory: `update()`, once per animation frame, returns
`clean`, `partial`, or `full`, and `clean()` marks the frame drawn.

```
update() ─ ghostty_render_state_update ─ get_multi(dirty, size, cursor, colors)
   │ clean: done — two calls, nothing allocated
   └ else, per row: next + get_multi(dirty flag, id, raw cells, cells handle)
        clean row with a known id → its previous object
        dirty row → decode its raw cells (one u64 each, bits from the manifest)
             a style id new to the row → select + STYLE, interned by value
             a multi-code-point cluster → select + GRAPHEMES_BUF
           → runs; equal to the previous object under that id → keep that
```

- **Rows** are `{id, runs}`, every viewport row in order. The id is the
  library's row identity as a string: it stays with a row as the screen
  scrolls, so it keys a keyed list. A row's object is replaced only when
  its contents change — the library rebuilds every row after an ordinary
  scroll, and
  the reader compares what it decoded with the previous object under the
  same id — so a keyed list re-renders just the rows whose object is new.
  The row's position is its index; the object holds none, so it survives
  moving. An edit that moves rows within the library's page — a scroll
  inside a scroll region (DECSTBM), inserted or deleted lines, some erases
  — gives every row of that page a new id, rows outside the edit included,
  so those rows come back as new objects, on what may be only a `partial`
  update. Ids are unique within an update, but the library numbers each
  screen's rows on its own: after a
  switch between the primary and alternate screens an id can come back for
  a different row, whose object then holds that row's contents.
- **Runs** cover a row from column 0 without gaps, up to its last cell that
  draws anything: trailing blanks in the default style are dropped (and
  the unstyled spacer head a wrapped wide character leaves in the last
  column), a
  styled blank is kept, and a cell of background only (an erase with a
  color, held in the cell rather than a style) is a space in that
  background. A run is consecutive cells with one style and one hyperlink
  flag, with its column `x` and its `width` in columns, so nothing needs
  measuring: a plain run has one code point per narrow cell; a wide
  character or a grapheme of several code points (combining marks, a ZWJ
  sequence under mode 2027) is a run of its own, a `cluster` to box to its
  width, since a fallback font's glyph needn't match the cell. The second
  cell of a wide character has no text and makes no run.
- **Styles** are interned per reader by value and carry a stable `key` to
  cache derived CSS by. The cache holds two generations — the styles the
  current update read and the previous update's — so it stays about two
  screens' worth however many styles a program makes, and a style read in
  consecutive updates that read rows keeps its object (a row kept unchanged
  doesn't count as a read); one unread for such an update is let go, and
  comes back as a new object with the same key, so styles are compared by
  key. A color is `null` for the default, a palette index,
  or RGB; palette colors stay indices, so a palette change recolors without
  touching rows. Flags are the SGR ones; `inverse` is left for the renderer
  to apply after resolving defaults. Style ids in cells are only meaningful
  within their row's page, so the reader caches the ids it has read per row
  only; id 0 is the default style, read without a call.
- **Cursor and colors** are read on every update, since a cursor shape, its
  visibility, or a default color (OSC 10/11/12) changes without dirtying a
  row; a palette change (OSC 4) is a full update. Each is a new object
  only when it changed. The default foreground and background are the
  library's white-on-black placeholders until the terminal has both set:
  the render state takes them only as a pair, so an OSC 11 alone still
  reports the placeholders.

A terminal has at most one live `GhosttyRenderState` — a second is refused
— since an update consumes the terminal's change tracking and a second
reader would miss what the first took. The output is plain immutable data,
so any number of views can share one reader. After it's disposed a new one
can be made, and its first update is a full frame.

The library misses one change: with grapheme clustering (mode 2027) off, a
combining mark or other zero-width character that arrives in a write of its
own joins the cell before it without marking that row changed. The update is
`clean` and the row keeps showing the cell without the mark until anything
else changes the row, which brings it back right. With mode 2027 on, or the
mark in the same write as its base, it's tracked. The reader can't detect
it, so `FuzTerminal` creates every terminal with the mode on (below); a
program that turns it off brings the gap back for that terminal.

The reader's calls only write buffers it owns, after the update itself, so
it reads its views of memory across them, taking them again if one ever
came back detached and always after growing its own grapheme buffer. The
cell data is borrowed from the render state until the next update; the
reader copies what it keeps before then.

## Render holds

A program redrawing the whole screen sets synchronized
output (mode 2026) so it isn't seen half-drawn. The library reports the
hold through the `render_hold` effect, `true` at the start — when the
terminal holds exactly the frame to keep showing, later bytes of the same
write not yet parsed — and `false` at the end (the mode reset, a full
reset, or a resize). A renderer updates its `GhosttyRenderState` from the
handler when a hold begins, then doesn't update until it ends — or until a
timeout of its own, after which it stops honoring the hold, since the
terminal has no clock and never ends one itself. Updating from
a handler is allowed: an update reads the terminal and consumes its change
tracking without changing what it shows, and effects fire between whole
steps of the parse. Writing, resizing, or disposing the terminal from a
handler still throws `GhosttyReentrancyError`.

## Keyboard input

A key reaches a program as bytes, and which bytes
depends on modes the program sets in its output: the up arrow is `ESC [ A`
until it turns on application cursor mode, then `ESC O A`; under the Kitty
keyboard protocol most keys become `CSI … u` sequences. libghostty-vt's key
encoder holds those modes as options — the cursor and keypad application
modes, backarrow mode (DECBKM), the alt escape prefix, modifyOtherKeys, and
the Kitty keyboard flags — and its sync call copies them from a terminal
when it's made; it doesn't stay attached. `GhosttyKeyEncoder` (refused
with `GhosttyLoadError` for a module built without the `input_encode`
feature) syncs before every encode, so a mode set by output written just
before a key press decides what the key sends:

```
keydown ─ FuzTerminalState.handle_key
   │ not ready, composing, or a key the browser keeps → not taken (default runs)
   └ to_fuz_terminal_key_input(event) → {action, key, mods, consumed_mods, text, unshifted}
        GhosttyKeyEncoder.encode ─ set_from_terminal ─ set the event ─ encode
           │ out of space → grow the output buffer to the size asked, encode again
           └ bytes → ondata, and preventDefault; none → default runs
```

- **The encoder** keeps one key event and its own buffers for its life: the
  event points into the encoder's text buffer (the library doesn't copy
  text), the output buffer grows once if a sequence doesn't fit, and after
  the first keys an encode allocates nothing in the module. A terminal may
  have any number; encoding reads the terminal and changes nothing. The
  bytes are the library's encodings, Ghostty's own, which differ from what
  xterm-style terminals commonly send: modified Enter, Tab, and Escape send
  the library's distinct sequences in every mode (Shift+Enter and
  Ctrl+Enter are `CSI 27;2;13~` and `CSI 27;5;13~` — a plain shell prints
  junk for them); Ctrl+Shift+letter, distinct from Ctrl+letter, and Ctrl
  with some punctuation (`;` `'` `,` `.` and backtick, and on macOS, where
  the zoom keys aren't passed, `-` and `=`) send `CSI … u`; Ctrl+/ sends
  `^_`; modified PgUp, PgDn, and Insert carry their modifiers; and
  backarrow-key mode (DECBKM) is honoured. Mode 1035 is on by default, so
  application keypad mode (DECKPAM) leaves the keypad numeric until a
  program turns 1035 off.
- **Classic Ctrl chords** are the one place the encoder departs from the
  library, on purpose (`to_classic_ctrl_chord_bytes`). The library keeps
  Ctrl+[, Ctrl+I, Ctrl+M, and Ctrl+@ distinct from Escape, Tab, Enter, and
  NUL even in legacy mode, as fixterms `CSI … u` — junk to a program that
  asked for no keyboard protocol (bash's readline, whose vi mode takes
  Ctrl+[ for Escape; less; nano; a plain REPL). So when the program has
  asked for nothing, those four send ESC, Tab, CR, and NUL — ESC-prefixed
  with Alt, as the library prefixes its other Ctrl+Alt chords. Two
  conditions say it asked for nothing: the active screen's Kitty keyboard
  flags are zero (read from the terminal, `KITTY_KEYBOARD_FLAGS`, after the
  encode), and the library's output is its fixterms form — under
  modifyOtherKeys 2, which the C API doesn't expose, the output is
  `CSI 27;…~` instead, so it's left as the program asked. The chord's
  character is found as the library finds it for its other C0 chords: the
  text when it's one byte, else, with Ctrl alone, the physical key's — so
  German Ctrl+Ü, on the US `[` key, is ESC, and a `[` typed with AltGr isn't
  a Ctrl chord at all. Ctrl+Shift+I and Ctrl+Shift+M stay the library's (`@`
  takes Shift on a US layout, so Ctrl+Shift+2 is NUL). With the prefix,
  Ctrl+Alt+[ sends ESC ESC.
- **The mapping** (`to_fuz_terminal_key_input`) reads only the event's
  fields. The key comes from `code`: the library's key names follow the UI
  Events codes (`A` for `KeyA`, `DIGIT_1` for `Digit1`, `F12` for `F12`), so
  the table is built from the manifest's names by that rule
  (`resolve_fuz_terminal_key_codes`), plus a few
  legacy aliases and the numpad with NumLock off, which a browser reports as
  the digit's `code` with the navigation key's `key` (`Numpad1` + `End` →
  `NUMPAD_END`). A unit test holds the rule to every name in the manifest,
  and a wasm test holds the module's key enum to the fixture's, so an
  upgrade that adds keys fails until they're mapped. The text is `key` when
  it's a character — never a key name (`Enter`, `Dead`, `Process`,
  `Unidentified`) or a control character — and before any Ctrl
  transformation, as the encoder wants (`c` for Ctrl+C). Meta is the super
  modifier, CapsLock and NumLock come from `getModifierState`, a side bit is
  set only on a right-hand modifier's own event, and when AltGraph made the
  text Ctrl and Alt are dropped (Windows reports AltGr as Ctrl+Alt). The
  modifiers the text used up (`get_fuz_terminal_consumed_mods`) let the
  encoder send the text as typed: Shift whenever it's held and the key made
  text — Shift+A's `A`, AZERTY's Shift+`&` `1`, CapsLock with Shift's `a`
  are plain text to the Kitty protocol — except on Space and the numpad, so
  Shift+Space stays a shifted space. On macOS Option is the layout's level
  for typing characters, so Option that typed a character — with neither
  Ctrl nor Meta held — is not reported as Alt: it's dropped from the
  modifiers, as AltGraph's Ctrl and Alt are. A German Mac's Option+5 `[` and
  Option+L `@` are sent as `[` and `@`, not with the alt escape prefix
  (`ESC [` would start a sequence), and under the Kitty protocol's
  report-all flag the `[` arrives as the key's text; the price is that such
  a program can't tell Option was held. Option+Left, which makes no text,
  and Option with Ctrl are still Alt. The platform is
  `FuzTerminalDeps.key_platform`, from the client hints or
  `navigator.platform` by default (`to_fuz_terminal_key_platform`); the
  mapping takes it as an argument, so it's tested both ways. Option as Meta
  is still to come, as a host option.
- **The unshifted code point** is the key's text lowercased when it's a
  cased letter, the key's own text when nothing (Shift, Alt, AltGraph)
  changed it, and otherwise the character a US layout has on that physical
  key — or, for a key the US layout hasn't (`IntlBackslash`, `IntlRo`,
  `IntlYen`, an empty `code`), the text's own character, lowercased, so the
  key keeps its modifiers and its release. That's right for letters on any
  layout and for unshifted keys, and wrong for a shifted digit or
  punctuation key on a layout that puts another character there unshifted
  (German Shift+ß, `?`, reports the US `-`); under the Kitty protocol that's
  the key code sent, and its base-layout alternates assume US too. A
  browser's layout map (`navigator.keyboard.getLayoutMap()`) would fix it,
  but only Chromium has one.
- **Copy chords**: Ctrl+Alt+C and Ctrl+Insert, with no Shift or Meta,
  copy the page's selection when it takes some of the view's text — one
  that only touches the view's edge, as a triple-click on the block above
  it does, doesn't count (`is_fuz_terminal_copy_key`,
  `FuzTerminalDeps.read_selection`). The copy is the whole selection's
  text, even where it reaches outside the view — what the user selected,
  and what the browser's own copy would take — written with
  `navigator.clipboard.writeText` (`write_clipboard`; a secure context,
  which `localhost` is, and the key press is the user activation it needs).
  A key that copied sends nothing, is prevented, and isn't held, so it
  sends no release either; it copies whatever the status or
  `accepts_input`, since a stopped view still shows its last frame. A write
  that fails or rejects is reported through `onerror` and the notice, never
  thrown, and the next copy that succeeds clears that notice. With no
  selection there the chord is the program's, as any other key. Ctrl+C is
  always the program's. The view writes the clipboard itself rather than
  leave the chord to the browser: Ctrl+Alt+C is no browser shortcut, and
  Ctrl+Insert, which browsers on Linux and Windows copy with, must reach
  the program when nothing is selected. C is matched by the layout's
  character, or by the physical key when the layout's is a letter of
  another script (Cyrillic `с`), never with AltGraph held, nor when
  Ctrl+Alt made a Latin letter or a symbol — Windows reports AltGr as
  Ctrl+Alt, and Polish AltGr+C types `ć`. On macOS neither chord copies:
  Cmd+C is the platform's copy and passes to the browser as a Meta
  combination, so, as with the zoom keys, Ctrl+Option+C and Ctrl+Insert
  stay the program's.
- **What the terminal doesn't take** keeps its default: a key while the
  view isn't ready; a keydown in a composition — an IME's (`isComposing`,
  `Process`, key code 229) or a dead key — whose text arrives later (a dead
  key's composed character comes as the next keydown's `key`, and is sent;
  an IME's needs a text input, still to come); any combination with Meta,
  the OS's and the browser's shortcuts; Ctrl+Shift+C and Ctrl+Shift+V,
  reserved for copy and paste; and, except on macOS, the browser's page
  zoom: Ctrl with `=`, `+`, `-`, `_`, or `0`, Shift or not, the numpad's
  `+`, `-`, and `0` included (`should_fuz_terminal_pass_key`, one function
  so a host override can be added). The zoom keys are matched by the
  layout's character, so on a German layout Ctrl with the `+` key passes
  and Ctrl+ß doesn't. With Alt held they stay the program's: Windows reports
  AltGr as Ctrl+Alt, and browsers don't zoom on Ctrl+Alt. On macOS the
  browser zooms with Cmd, a Meta combination already passed, and Ctrl with
  them is the program's. Everything else the encoder has bytes for is the
  program's, as in other browser terminals: Tab, Escape, the function keys,
  Ctrl+W, Ctrl+digit. A modifier alone, or a key the encoder has nothing
  for, sends nothing and keeps its default.
- **Errors** go the way writes' do: a library failure while encoding fails
  the view and an escape poisons it — neither leaves the event handler —
  and an `ondata` that throws is reported, not fatal. Key bytes and the
  terminal's replies share `ondata`, in the order they happen.

### The Kitty keyboard protocol

The Kitty keyboard protocol lets a program ask for unambiguous key
reports — every key and modifier as an escape code, presses, repeats, and
releases told apart, the text a key produced. It can't be left
unadvertised: the library always takes a program's push, set, and pop of
the flags, and answers its query (`CSI ? u`) through `write_pty`; no
terminal option, mode, or build feature turns that off — so a program
that asks (neovim, helix, fish) finds it and turns it on. Encoding legacy
while the terminal told the program otherwise would have it misparse keys,
so the encoder follows the flags as set — each screen has its own, so a
program leaving the alternate screen leaves its flags there — and the view
supports the protocol as far as browser events allow. A `keyup` is encoded
as a release, which sends bytes only while the program has event reporting
on (legacy encoding and the protocol's other flags send nothing for one),
and only for a key whose press was taken — it reached the encoder, whether
or not it sent anything. A taken press's release is encoded whatever the
modifiers are by then (Meta added while the key was held, or Shift making
a Ctrl+C into Ctrl+Shift+C), and once; a release whose press went to the
browser, was composed, or came before the view had focus is dropped, and
the keys held when focus leaves are forgotten. The protocol's key codes are
the unshifted code points above, so their US-layout fallback carries over.

## The DOM renderer

`FuzTerminal` draws one terminal's screen as DOM
text, and takes its keys (above) and the text its host pastes (§ Paste,
below). It takes no paste events of its own (Ctrl+Shift+V, Shift+Insert, a
middle click), IME, focus reporting, or mouse reporting yet, doesn't scroll
into the scrollback, and has no selection of its own: the rows are text, so
the browser's selection works over them, and the copy chords (above) copy
it. Each row is a block of
inline runs, so a selection copies a row as one line and a block of rows as
one line per row — a soft-wrapped line copies broken at the wrap (the rows
don't carry the wrap flag yet). It has no dependency on zzz's app — no
cells, no actions.

### Ownership

The host loads and compiles the module and passes it — or the
promise of it, a fetch and compile in flight — as `module`; the view is
`loading` until it settles and `failed` if it rejects. The view
instantiates its own instance, terminal, and render-state reader, and frees
the terminal (which frees the reader first) and drops the instance on
unmount; unmounted before the module arrives, it instantiates nothing. One
instance per view: an escape that poisons an instance stops only that view,
a huge terminal's memory growth is its own, and an unmounted view's linear
memory can be collected (wasm memory never shrinks while its instance
lives). Instantiating from a compiled module and creating the terminal and
reader is cheap next to the compile the host does once; each instance
parses its own type manifest, the larger part of that cost.

### Modes

Every view's terminal is created with `FUZ_TERMINAL_MODES`, set as
the modes' reset defaults (`GhosttyTerminalOptions.modes`, the library's
`GHOSTTY_TERMINAL_OPT_MODE_DEFAULT`), so a full reset (RIS) keeps them:
grapheme clustering (mode 2027) on, so an emoji sequence or a base and its
combining marks take one cell, and a mark in a write of its own is drawn. A
program can still turn it off. It's the view's, not a prop: a host has no
reason to want the stale rows that come with it off.

### Host API

Props: `module`; `scrollback_max_bytes` (unset, the library's
default, which keeps a single page of history; zzz's `TerminalView` passes
`TERMINAL_SCROLLBACK_MAX_BYTES`); `label`, the
accessible name; `accepts_input` (default on — off, a key is neither encoded
nor prevented, so the browser's default runs, and the cursor is drawn
hollow, as when unfocused: hollow rather than hidden, so where the program
left it stays visible; drawing, selection, copy, resizing, and replies to
queries go on); and the callbacks `ondata` (bytes for the PTY: the keys
typed, and the terminal's replies), `onresize`
(the size in cells, at creation and on each change), `ontitle`, `onbell`,
`onstatus`, and `onerror`. `module` and `scrollback_max_bytes` are read once,
when the view starts; the callbacks whenever they're called, and never once
the view is destroyed. Through `bind:this` the host calls:

- `write(data, options?)` — bytes or a string, written in call order:
  queued while the module loads; from a callback inside a write, written
  right after that write rather than reentering it. Callbacks may make at
  most `FUZ_TERMINAL_MAX_CALLBACK_WRITES` writes during one outermost write
  or resize — past that they're dropped and reported through `onerror`, so
  an `ondata` that writes its replies back as output can't loop forever.
  `{replay: true}` marks output replayed from a buffer: it's processed with
  the reply effects (`write_pty`, `bell`) unregistered, whether it arrives
  while loading or later, so a query in it is never answered and a bell in it
  never rings, whatever it's interleaved with. A title it sets reaches
  `ontitle`, a render hold it starts is honored, and what it does to the
  terminal's state carries forward (above).
- `paste(text, options?)` — the text sent to `ondata` as a paste (§ Paste,
  below), returning what happened.
- `get_text()` — the active screen and its scrollback as plain text
  through the formatter (trimmed, soft wraps joined), for a copy-all.
- `focus()`, `get_status()`, `get_size()`.

The status is `loading`, `ready`, `failed` (the module didn't arrive,
compile, or instantiate, the terminal couldn't be created, or the library
failed), or `poisoned` (`GhosttyVt.poisoned`); a failed or poisoned view
keeps its last frame, shows a plain-text message, ignores writes, and a host
recovers by mounting a new one. `onstatus` hears of `ready` after the writes
queued while loading are written, so a write it makes follows them, and
replies to those writes reach `ondata` before it. A
callback that throws — inside a write, from a frame, or on a resize — never
escapes: it's handed to `onerror` (or the console) and shown as a notice,
and the view goes on; so is a failed copy (above), with its own notice.

### Paste

`paste(text, {allow_unsafe?, max_length?})` sends text as the
person pasting it: encoded under the terminal's modes as they are now
(`GhosttyTerminal.encode_paste`, over the library's `ghostty_paste_encode`)
and handed to `ondata` in one call, like a key's bytes. The encoder replaces
the control bytes xterm strips from a paste (NUL, BS, ENQ, EOT, ESC, DEL,
and the tty's special characters such as Ctrl+C, Ctrl+Z, and Ctrl+U) with
spaces, then frames the text in `ESC [200~` … `ESC [201~` when the program
has turned on bracketed paste (mode 2004), or turns each newline into a
carriage return when it hasn't. Every change is an ASCII byte for an ASCII
byte, never a byte of a multi-byte sequence, so the encoded length is
known before encoding (`to_ghostty_paste_length`: the text's length in
UTF-16 code units, plus the frame's 12 when bracketed).

Before encoding comes the library's terminal-aware safety rule
(`get_ghostty_paste_hazard`, its `isSafeWith`), on the text as given:
bracketed, text holding the end sequence `ESC [201~` is unsafe
(`paste_end`); unbracketed, so is a newline or carriage return
(`line_break`), since each reaches the program as Enter. Unbracketed text
holding both is reported as `line_break` — that's what runs commands as the
text arrives, while the end sequence's ESC is replaced anyway; whether text
is safe is the library's call, which hazard is named the binding's. Unsafe
text is refused (`rejected`, with the hazard and whether the paste is
bracketed) unless `allow_unsafe` names that risk: the host asks the person,
then pastes again passing the `rejected` result's hazard and mode
(`GhosttyPasteRisk`). A confirmation covers only what was asked — if the
program toggled bracketed paste in between and the text's hazard or mode
changed, it's rejected again as it is now, and text the toggle made safe is
sent.

Nothing is sent while the view takes no input (`unavailable`: not ready,
`accepts_input` off, or from a callback inside a write, where the bytes
would land among its replies, a replay's included), for empty text
(`empty`), or when the encoded text is longer than `max_length`
(`too_large`, in UTF-16 code units of its bytes decoded as UTF-8, framing
included). The length is checked before the text's safety, so a paste that
can't fit is reported `too_large`, never `rejected`, and is never asked
about: a paste goes whole or not at all. The library's own
`ghostty_terminal_paste` makes the same bytes — a Kitty paste event (mode
5522) needs a clipboard-read effect, which the view never registers — but
reads its text through a callback and streams the result through
`write_pty`; encoding in one call lets the host measure it before anything
is sent, and needs no callback into the library's writer.
`ghostty_paste.wasm.test.ts` checks the two against each other — the rule,
the bytes, and the length, a rejection's too — over texts that probe the
rule and the encoder and over seeded random ones.

### Keys and the page

While the view takes keys — ready, `accepts_input` on
— its root carries `data-fuz-terminal-keys` (`FUZ_TERMINAL_KEYS_ATTRIBUTE`),
and `is_fuz_terminal_key_target(target)` says whether an event target is
inside such a view. A page's global shortcuts check it beside their check
for a text field: the view takes keys on a focusable `div`, which isn't an
editable element, and every key typed into it may be the program's.

### What a host provides

A sized box: the view fills its container (`width`
and `height` 100%), and its own content never sizes it — the rows are a
layer positioned over the root's box. So the container needs a definite
size: an explicit height, or a stretched flex or grid item (`min-height: 0`
in a flex column). A container with no size leaves the view unmeasurable,
and the terminal keeps its size (`FUZ_TERMINAL_DEFAULT_SIZE` at first)
until the box has one. A view whose first frame finds no size warns once in
the console, naming what's missing (a hidden view warns too); it's never a
failure.

### The frame loop

A frame is requested after output, after the box changes
size, and when a render hold ends, and at most one is pending
(`FuzTerminalFrameLoop`); with nothing changing nothing is scheduled. A
frame resizes the terminal if the box changed, then updates the reader and
takes `rows` when the update wasn't clean, and the `cursor` and colors by
reference every frame, since those change on clean updates too, then cleans
it. The rows are held in `$state.raw` and drawn by a keyed `{#each}` over the
row ids: an unchanged row is the same object, and Svelte skips a keyed item
whose value is the same reference, so its elements aren't touched; an
ordinary scroll moves the elements of the rows still on screen. A scroll
inside a scroll region, or inserted or deleted lines, gives every row of the
library's page a new id, so those frames recreate every row's elements.

### Render holds in the view

On the `render_hold` effect's start the view updates from
inside the handler — the frame the program wants left on screen — and
updates nothing more until the hold ends or `FUZ_TERMINAL_RENDER_HOLD_TIMEOUT_MS`
passes; after that it draws again. It can't end the hold in the terminal
(that needs the mode option, unbound), so a hold the program starts before
resetting a timed-out one isn't seen. A hold that begins after the view was
destroyed or stopped — later in the same write — does nothing.

### Drawing a row

The rows stack in block flow in the screen layer, so row
`y` starts `y` rows down, where the cursor is placed; a row is a block with a
pinned height, and each run is an inline box (`inline-block`, top-aligned) as
wide as its columns. A run is drawn at its own column, never after the runs
before it: an engine rounds each box's width to its layout unit, and a
fractional cell width rounded run by run drifts a style-dense row
(`ls --color`, htop) a pixel or more off its columns, the cursor sitting off
the text. So a run takes no room in the line — its
`margin-right` is its `width` negated, the same length, which rounds to the
same magnitude — and is offset from the row's start by `position: relative`
with `left` of its column (`--run_x`) times the cell width, the expression
the cursor is placed by: every run and the cursor are one rounding of
`x × cell` from the row's start, however many runs come before. A run's box
is a sixteenth of a pixel wider than its columns, so it overlaps the next
run's box, which paints over it, and the two roundings that end one run
and start the next can't leave a hairline of the row's background between
them. The runs are still inline boxes in DOM order, so a row copies as one
line. The layer and the rows set their own `display`, and
their classes are prefixed (`fuz-terminal-screen`, `fuz-terminal-row`): no
class the component renders is a fuz_css utility or base-style class
(`FuzTerminal.classes.test.ts`), since a utility of the same name would lay
them out too. Every box —
runs, clusters, the cursor — is sized in one cell width, the probe's
measurement, set on the root as `--fuz_terminal_cell_width` and
`--fuz_terminal_cell_height` in pixels (falling back to the font's own `1ch`
and line until there's a measurement), never each run's own font: a bold
face whose advance differs can't shift the columns after it. So a glyph from
a fallback font can't shift what follows either. A cluster run (a wide
character, a multi-code-point grapheme) is one box of its width; a run whose
text mixes ASCII and other code points is split where it changes between
them (`split_fuz_terminal_runs`), so a stretch of glyphs the font lacks
shifts at most within itself. The root resets the text properties a host
would pass down that move runs off their columns or change their glyphs:
`direction`, `writing-mode`, `text-align` and `text-align-last`,
`text-indent`, `text-transform`, letter and word spacing, kerning,
`font-weight` and `font-style` (so only a program's style makes text bold or
italic), the font variants (ligatures off), font feature and variation
settings, and `user-select` (a host's `none` would leave nothing to select).
The font and its size are the host's through `--fuz_terminal_font_family`
and `--fuz_terminal_font_size`, which the root reads instead of inheriting
them; what else a host passes down — paint such as `text-shadow`, or
`font-stretch` — is the host's to set.
Trailing blanks make no run, so the row's background shows. Text reaches
the DOM only as text nodes; a run's `style` attribute holds only
declarations built from the style's flags and colors formatted from numbers
(`to_fuz_terminal_style_css`, cached by style key and bounded): colors,
`inverse` swapping the resolved colors (defaults included), `faint` as the
text color mixed toward transparent, `invisible` as transparent text and
lines, bold, italic, and the underline kinds, strikethrough, and overline
as `text-decoration` lines. Blink and hyperlinks are classes: blinking
text, off under `prefers-reduced-motion`; a hyperlink underlined on hover,
with no link to follow.

### Colors

Colors are never read from the theme into JS. Runs name custom
properties — `--fuz_terminal_fg`, `--fuz_terminal_bg`, and
`--fuz_terminal_palette_0` … `_255` — that the root defines. The stylesheet
gives the defaults and the base 16 from the theme; the root's inline style
(`to_fuz_terminal_theme_css`) sets palette entries 16–255 from the frame,
and overrides a base-16 entry only when it differs from the palette the
reader reported before any output (a program changed it with OSC 4; OSC 104
gives the theme's back). The default text color and background are the
theme's while the reader reports the library's placeholders, and the
program's once it has set both (OSC 10 and 11 — the library takes them only
as a pair). Reverse video (DECSCNM) isn't drawn while the defaults are the
theme's: the library swaps only colors a program set, so with its
placeholders the frame's colors don't change. A cursor color the program
sets (OSC 12) is its own property on the root, so a program that recolors
the cursor often (vim, per mode) leaves the palette's style alone. A host
themes the view by setting, on an ancestor:

| custom property | default |
| --- | --- |
| `--fuz_terminal_foreground` | `--text_color` |
| `--fuz_terminal_background` | `--shade_00` |
| `--fuz_terminal_cursor_color` | the text color in effect (a program's own included) |
| `--fuz_terminal_color_0` (black), `_8` (bright black) | `#1c1c1c`, `#808080` |
| `--fuz_terminal_color_7` (white), `_15` (bright white) | `#c8c8c8`, `#f8f8f8` |
| `--fuz_terminal_color_1`–`_6` (red, green, yellow, blue, magenta, cyan) | `--palette_c_50`, `_b_`, `_e_`, `_a_`, `_d_`, `_i_` |
| `--fuz_terminal_color_9`–`_14` (the bright ones) | the same hues at `_70` |
| `--fuz_terminal_font_family` | `--font_family_mono` |
| `--fuz_terminal_font_size` | `--font_size_sm` |
| `--fuz_terminal_line_height` | `1.2` |

Only the default foreground and background follow the color scheme. ANSI
black is dark and white light in either scheme — programs rely on that
(black text on a green status bar, white on blue) — and fuz_css's gray
scales follow the scheme (its only fixed opaque neutrals are pure black and
white), so these are literal grays. The six
hues are fuz_css palette stops, the bright ones the higher-contrast stops in
either scheme. The terminal itself isn't told the theme, so a program that
queries a color (OSC 10, 11, or 4) gets the library's placeholders.

### The cursor

One element over the rows at the cursor's cell, two cells
wide over a wide character (on either of its cells), in the shape the
program set — a block (drawing the cell's text in the background color, or
a blank over invisible text), a bar, an underline, or a hollow block — and
hidden when the program hides it or it's out of the viewport. Without focus
a block is hollow and nothing blinks; a blinking cursor blinks by CSS, not
under `prefers-reduced-motion`.

### Sizing

A hidden probe — a run of cells in the terminal's font, with the
line height the rows fall back to, unselectable so no copy takes its text —
measures the cell (its width over its length, its height a row's), and the
root's box is the area; `to_fuz_terminal_size` turns them into cols and
rows — whole cells, at least `FUZ_TERMINAL_MIN_COLS` ×
`FUZ_TERMINAL_MIN_ROWS`, at most
`GHOSTTY_TERMINAL_MAX_SIZE` — or `null` when anything is zero or not finite
(not laid out, `display: none`, no size from the container), which never
resizes the terminal. A `ResizeObserver` on the root and the probe (so a font
that loads late re-measures too) requests a frame, so a storm of size
changes costs one resize per frame. The terminal is created at the measured
size, or `FUZ_TERMINAL_DEFAULT_SIZE` when there's nothing to measure yet.

### Accessibility

The root is focusable (`tabindex="0"`, a `group` with the
`terminal` role description and `label` as its name) and takes the keys
typed while it has focus; the rows are plain
text in the accessibility tree, the cursor and probe are hidden from it,
and nothing is a live region, so a repaint announces nothing. A deliberate
screen-reader mode is still to come.

The module is a static asset (`static/fuz_terminal/ghostty-vt.wasm`) built by
`cargo xtask ghostty-vt`, not an import, so a build without it still
succeeds. It isn't committed (the path is gitignored), so `gro build`'s
cache, keyed on the commit, doesn't notice it appearing: a build cached
before the module was built is reused without it, until `gro build
--force_build`. The tests that load it
(`src/test/fuz_terminal/**/*.wasm.test.ts` and
`src/test/TerminalView.wasm.test.ts`) are the `fuz_terminal_wasm` vitest
project, which `vite.config.ts` defines only when the module is there, so a
checkout without it — CI included — runs everything else, with a one-line
notice that the project was skipped; the manifest and load checks that need
no module (against a manifest fixture) run in `unit`.

# Projects, Roots, and the Filer

What a project is and how opening a path resolves one, which directories
can be roots, and the file index and its watcher. The rest of the
filesystem — the app directory, `ScopedFs`, reads, and the byte routes —
is ./architecture.md § Filesystem; editing files is ./architecture.md
§ File Editing. Their limits close this doc (§ Known limitations).

## Projects

Directory scoping on top of the app directory and the scoped dirs
(./architecture.md § Filesystem):

- **Project** — the root a path opens, which the server
  serves and indexes in part. `project_open` takes a file or directory and
  resolves its project on a blocking thread (`crates/zzz_server/src/project.rs`,
  `resolve_project` — a file opens its parent):
  1. **A registry** — a `repos.toml` found walking up by `fuz_repos`'s
     discovery, rooted where a link above a checkout names it (so
     `~/dev/repos.toml`, a link to a copy in one of its repos, roots at `~/dev`),
     else at its own directory. The walk stops below `$HOME` (or within
     the allowlisted root holding the path), and a candidate must be
     trusted — the file and every directory from it up to `$HOME`, that one
     included, owned by the daemon's user or root, never `o+w`, and `g+w`
     only by the user's private group (Debian sshd's rule,
     `file_trust.rs`; the owner is read once at boot) — and, when a
     symlink, confined to the root it would make. Any candidate that fails
     refuses the open with its reason (`registry_untrusted`,
     `registry_not_confined`, `registry_changed`, `registry_unreadable`,
     `registry_invalid`) rather than being skipped, since a skip would widen
     the root to a registry further up — unless it's kept inside a
     checkout (below). Each entry is canonicalized and confined to the
     root: one that escapes it, is protected, can't be resolved, isn't a
     directory, or is in a git dir (an entry named `.git`) is refused alone
     (`entry_not_confined`, `entry_in_git_dir`, …), and one not yet cloned
     is `missing`. The registry roots the project when the path is in one
     of its present entries, or is its root or outside it (a linked
     worktree) — unless no entry is present and the root is a checkout; a
     path under its root in no present entry falls back, as do the root of
     a checkout with no entry present and a linked worktree of it, so a
     root has one kind whichever path opens it. A path under a `.git`
     component opens as the directory holding the outermost one.
  2. **A git checkout** — the nearest directory at or above the path, inside
     the same bound, holding a `.git` that is itself a directory or a
     regular file (a linked worktree's), by `lstat`; anything else named
     `.git` is ignored — a symlink too, whatever it points at, so a
     directory whose `.git` is a symlink is no checkout. Rule 1's
     discovery reads a checkout the same way, runs no git in a directory
     whose own `.git` is a symlink, and stops git's own search (which
     passes over a `.git` it can't use and walks on up) below the nearest
     symlinked `.git` above where it runs, so no git call goes through a
     symlinked `.git` to a git dir elsewhere — never followed, as
     `ScopedFs` refuses symlinks. A registry in a directory whose own
     `.git` is a symlink opens as a registry rooted there, where the
     `repos` CLI refuses that root (`root_git_symlink`): zzz never clones,
     so the sync that refusal guards against can't happen.
  3. **The directory itself.**

  **Fallbacks** — a registry found by rule 1 that doesn't root the project
  hands it to rules 2 and 3 and is reported as the project's `fallback`
  (`{kind, registry_path, reason?}`, on the reply, `project_changed`, and
  `project_list`):

  - `unregistered` — the path is under the registry's root in none of its
    present entries (`~/dev/scratch`, a checkout `~/dev/repos.toml`
    doesn't list), or is the root of a checkout holding the registry with
    no entry present (a repo's own `repos.toml`, nothing cloned), or is a
    linked worktree of that checkout outside the root, which opens as its
    own checkout (the one rule 2 alone would find). Otherwise its checkout
    is looked for at or below the root, never above it, and strictly below
    it when any entry is present: a root
    holding clones is a workspace that a checkout there would index whole.
  - `registry_refused` — a registry kept inside a checkout (the nearest
    one, with no link above its checkout naming the same file) that is
    untrusted, unconfined, protected, unreadable, or invalid, carrying that
    `reason`, falls back to a checkout holding the path at or below the
    registry's own directory — what the open would root at without the
    file. A registry outside any checkout, one a link above names (that
    link would have rooted the open), one whose checkout is above its
    directory (falling back would widen), and one replaced mid-open still
    refuse. A root inside a checkout of one of its own entries falls
    back the same way, at or below its own directory — or, from a linked
    worktree outside it, that worktree's own checkout, the one rule 2 alone
    would find (`registry_root_in_entry`).

  No fallback widens: each root is at or below the root the registry
  would have made, or, from a linked worktree outside it, the worktree's
  own checkout, and nothing read from the registry passed over decides
  it but a root-in-entry registry's entries.

  The opened directory and the root must both pass the root rules (§ Root
  scope) and lie outside every protected directory. The open **focuses** the
  repo holding the path — the deepest present registry entry containing it,
  or a checkout's or directory's root; opening a registry's root itself, or
  a linked worktree outside it, focuses nothing. Focus is daemon-wide; each
  open of a path in another repo adds its focus (`project_changed`
  `update`), and `repo_focus` / `repo_unfocus` add or drop a registry's
  present entries one by one without resolving the registry again. A focus
  lasts until it's unfocused, the project closes, or a later open finds its
  entry gone; a checkout's or plain directory's root is its one focus while
  it's open (`project_not_registry`), and a registry may keep none, as
  opening its root alone leaves it. An open may also request more focus
  (`focus`, the shape a reopen after a restart takes): each requested
  directory is checked against the fresh resolve as a kept focus is (a
  present entry; a checkout's or plain directory's root lands, anything else
  on one is `project_not_registry`) and lands or is refused alone, reported
  in the reply's `refused` with the code `repo_focus` would refuse it with
  (`repo_not_in_project`, `repo_not_present`, `permission_denied`, or
  `repo_index_failed` for a listing that failed otherwise). A focused
  directory gets a whole-tree filer; a registry's root gets one at its top
  level alone (its loose files) — an unfocused repo and an unregistered
  directory under it aren't indexed by the registry's project (an
  unregistered directory opened by a path in it is its own project, indexed
  whole), so a root of hundreds of thousands of files costs only what's
  focused. Filers are keyed by canonical path, so two entries resolving to
  one directory share one. The root is one `ScopedFs` root, writable whole.

  The filers start before the project manager's lock is taken (the root or
  the path's own focus that can't be listed fails the open, with nothing
  registered, while a requested focus that can't is refused alone; and
  concurrent opens of one path share a scan), then, under the lock, the
  project is recorded — merged into an open one with the same root: the
  fresh kind, entries, and `fallback` (why it's rooted there now — a change
  counts as one, stamping a new rev), the union of the focus that the fresh
  resolve still supports (a present entry's dir, or the root of a checkout
  or plain directory; a whole-tree filer on a root now indexed at its top
  level is replaced by a top-level one) — the filers re-ensured, the root
  added to `ScopedFs`, and `project_changed` broadcast (`open`, or `update`
  when an open project changed) — one commit and one notification for the
  open and every focus it requested. Each requested focus's filer is ensured
  again under the lock before the commit, so one stopped since its scan (a
  racing unfocus or close) is refused alone rather than failing the commit.
  The reply carries the project, the open's `focus`, every filer's files
  (each requested focus that landed included), the `watch_status`, and
  `refused`. `repo_focus` checks the entry is present as the project's last
  resolve left it (`repo_not_in_project`, or `repo_not_present` for one not
  cloned or refused), starts its filer before the lock, then under it
  records the focus, re-ensures the filers, and broadcasts `update`,
  replying with the project, the focused repo's files alone (the rest of the
  project is the client's already), and the project's `watch_status`;
  focusing a focused repo changes and broadcasts nothing. `repo_files` reads
  a focused directory's files under the lock, so it never sees a filer a
  commit has stopped or narrowed but not yet published, refusing a root that
  isn't open (`project_not_open`) and a directory the project doesn't focus
  (`repo_not_focused`) rather than answering with no files, as an empty repo
  would. `repo_unfocus` drops the focus under the lock and releases its
  filer as an open's narrowing does — stopped unless another open project
  keeps it, narrowed to a top-level one if that's all one keeps (a nested
  registry's root) — then broadcasts `update`. `project_close` reverses an
  open, stopping the filers no other open project keeps and narrowing a
  whole-tree one another keeps at its top level alone — except that the
  boot-time app directory and `PUBLIC_ZZZ_SCOPED_DIRS` keep their permanent
  filers and `ScopedFs` roots, so closing a project that overlaps one never
  revokes its access. Backend state is an in-memory map — a restart forgets
  all projects, and clients reopen the ones they had when they resync after
  reconnecting (see **Reconnect resync** under File Editing). Scoped dirs
  aren't listed as projects: they're the operator-configured always-on
  layer; projects are the user-opened runtime layer. A scoped dir (or the
  app directory) can still be opened, and closing it leaves its permanent
  access in place.

One open project is the **active** one on each client (`Projects.active`):
new files and folders default into it (`Project.new_files_dir` — its
last open's focus while that's still focused, else its root).
`DeskMenu.svelte` lists the open projects to switch it. Opening happens on
`/projects`, the projects page, from its open form or the `?open=<path>`
query param — this is how the CLI's `zzz <path>` lands the browser there.
Both run `project_open`, activate the project it returns, and then open a
file the open indexed in a tab on `/files`; a directory, or a file the
index skips, leaves the page showing where it landed. Both take an
absolute path or one starting `~` or `~/`, expanded to the daemon's home
(`session_load`'s `home_dir`; the param waits for the session) — `~user`
is refused. The query param is handled once and then stripped from the
URL, so a reload doesn't reopen a project the user has since closed. The
page lists each open project with its kind, and a registry's registry file
and each of its entries: a present one with a button to focus or unfocus
it and its git status (§ Repo status below), a missing or refused one with
why.

**The lifecycle rev.** Every change to the open projects — an open that
changed something, a focus, an unfocus, a close — bumps the daemon's
project rev and stamps it on the project it changed (`ProjectInfoJson.rev`;
a close's on the closed project), so every reply and every
`project_changed` carries the rev its state was committed at:
`project_open` and `repo_focus` and `repo_unfocus` with the project,
`project_close` as `{rev}`, `repo_files` as the project's rev when it read
the index, and `session_load` as `projects_rev`, the rev its projects were
read at. The counter starts at the clock (microseconds since the epoch),
so revs keep increasing across a restart; they stay under 2^53, exact as
JSON numbers. A reply's files are read under the lock its change committed
under, so they're the index of exactly the state its rev names.

**Ignored paths on the wire.** Each project carries, for each focused
directory whose filer is on git's rule (§ Filer), what git ignores there
(`ProjectInfoJson.ignored`, keyed by the directory): `paths`, relative to it
and sorted — a directory git prunes whole with a trailing `/` (the directory
itself as `./`), a file it skips alone without — `nested`, the directories
the filer leaves unindexed as repos of their own (a nested repo, a
submodule, populated or not — git's paths never name them), relative,
sorted, each with a trailing `/`, and `resyncs`, a count. A focused
directory on fixed names has no entry, and neither has a registry's root
(indexed at its top level, on fixed names); a permanent filer's set (the app
directory, a scoped dir) is on the wire only while an open project focuses
its directory. Every commit reads the sets from the filers under the lock,
so a set that moved is a change of its project like any other, stamping a
new rev, and a reply carries the set its rev names. A filer whose set
changes on its own — a `.gitignore` or `info/exclude` edit re-pruning it, a
new file vetted as ignored, a `.git` appearing in a directory (one removed
is seen at the next rescan) — asks for that commit itself
(`refresh_ignored`, from a task of its own, at most once a second per filer,
since each refresh resends every changed project's whole set to every
client), once the step that changed it is done, so a refresh after a
re-prune reads the index that re-prune left. A re-prune that would send more
than 1024 `filer_change`s for one focused directory (un-ignoring a
`node_modules/` would be tens of MB to every socket) sends none and bumps
`resyncs` instead, dropping their pending changes too.

The client reads the sets as each root's rule (`Project.ignore_rules`,
merged in `Projects.ignore_rules`): one predicate, `to_unindexed_part` in
`diskfile_helpers.ts`, decides what the index skips for markdown links, the
file tree, the create notice, and whether a created file is waited for. The
daemon indexes the union of its filers, so a path is skipped only where
every root holding it skips it (`to_innermost_unindexed_part`; a registry's
root holds only its direct children), each by its own rule — git's paths and
nested repos for a focused directory with an entry (each folder prefix and
the path itself looked up in a set, never by the daemon's sort order), fixed
names for every other root — and the always-ignored names under both: a
`build/` git ignores in a checkout that a plain directory around it also
indexes reads as indexed. The names are copies of the filer's
(`FILE_INDEX_ALWAYS_IGNORED_NAMES`, `FILE_INDEX_PLAIN_DIR_IGNORED_NAMES`),
which a test holds to its Rust source. A refresh replaces `ignored`, so
links, the tree, and the notice follow it.

`Projects` applies project state from the daemon by one rule, whatever
order replies and notifications arrive in — this client's own
`project_changed` reaches it before its own reply, an HTTP reply can trail
a notification, and two clients' changes interleave:

- A held project takes a state only when its rev is newer than the one
  held; an older state is dropped whole, its reply's files with it (a
  reply's files are applied only when its state is the one held).
- A close older than the state held — the project opened again since —
  changes nothing. Any other leaves a tombstone, `(root, rev)`, and
  removes the project if held, releasing its files the index no longer
  covers as a narrowed state does (below): a root not held is added only
  by a state newer than its tombstone and than the last snapshot's
  `projects_rev` (state at or below it is one the snapshot saw). A
  snapshot that lists a root closed here after it was read leaves it
  closed and doesn't add its files.
- A newer state that narrows — drops a focus, a kind change included,
  since a checkout's or plain directory's one focus is its root — releases
  the dropped directories' files here (`Diskfiles.release_uncovered`),
  since stopping a filer deletes nothing on clients: a file still indexed
  (another focus, another root, a registry root's loose files) stays; one
  in a present but unfocused repo is forgotten unless a draft or a tab
  holds it, kept as it is — not flagged deleted, since it's still on disk —
  until the repo is focused again or nothing holds it; any other (its
  entry out of the registry or missing, under a root become a registry's,
  or under a closed project's root) is kept flagged `uncovered`
  (./architecture.md § File Editing). A repo that leaves the registry or goes missing releases its
  files too, focused or not.
  A kept file isn't watched meanwhile, so a change on disk shows only once
  the repo is focused again, or as a conflict when it's saved: an
  uncovered file's save sends the disk version it was based on
  (`expected_hash`), and a deleted file's creates it exclusively, refused
  if it's there.
- A newer state that widens — a project new here, opened elsewhere
  (another tab, `zzz <path>`), or a focus added elsewhere — arrives
  without its files (a filer's initial scan broadcasts nothing). What it
  needs is held pending, each directory with the state's rev, until no
  open or focus of this client's is in flight; an applied reply at or
  after that rev that carries the directory settles it. Then each repo
  still focused is pulled alone (`repo_files`, reconciled under the repo as
  a focus's reply is), and a project new here resyncs the session. A pull
  of an earlier focus than the one held — across an unfocus and a focus
  again — is dropped, as is one the daemon refuses as `repo_not_focused`
  or whose focus is gone here: the change that dropped it settles it.
- A newer state whose `ignored` entry for a directory focused before and
  after has a different `resyncs`, or came or went (a git root falling back
  to fixed names), marks a re-prune whose changes weren't sent
  (`is_resynced`): the directory goes pending like a new focus, settled by a
  reply carrying it or pulled once nothing is in flight — a checkout's root
  too, pulled rather than resyncing the session — and the pull reconciles it
  whole, pruning what's now ignored and adding what no longer is. The
  resync's rev becomes the directory's focus rev, so a pull read before it,
  of the index it replaced, is dropped like one of an earlier focus, in
  whatever order the pulls land. A change of the paths alone pulls nothing:
  a re-prune under the threshold sent its changes, and a file vetted as
  ignored was never indexed.

`Projects.focus_repo` applies its reply like an open's, reconciling the
repo's files (a draft kept while it was unfocused whose file is gone is
flagged deleted then); `Projects.unfocus_repo` applies its reply by the
same rule, so a reply older than another client's later focus of the repo
neither drops that focus nor releases its files.

The file tree shows one root row per open project's root, and under a
registry's root its present entries from the project (`Projects.repos`),
not from the index: a focused repo as a folder row, an unfocused one as a
dimmed lazy row with nothing under it, which expanding — Right, Enter,
Space, a click, or its menu's "focus repo" — focuses
(`DiskfileTreeState.focus_repo`), turning it into its folder row, expanded.
A missing or refused entry isn't shown (the projects page says why). A
repo's folder is always a row of its own, never part of a compact one, so
its row keeps its identity as it's focused or unfocused. A focused repo's
folder menu unfocuses it. A restart's reopen restores every focus however
it was made, in one `project_open` of the root with each focused directory
in its `focus`.

**Repo status.** The projects page shows each present registry entry's git
state from local refs — the branch when it isn't the followed one, an
operation in progress, uncommitted counts, distance from origin, stashes —
read as `repos status` reads it, no fetch (`project_status`,
`crates/zzz_server/src/repo_status.rs`). A poll never waits on git: it
answers with what the daemon knows and starts probes of the stale entries,
so the page (`RepoStatusPoll`) polls while it's shown and the tab is
visible, faster while a probe runs. An entry is stale when something under
its `.git` moved (refs, HEAD, an index, the stash, the config — a stat
stamp, no git run), when its focused checkout's filer broadcast a change
(editing a tracked file moves nothing under `.git`; at most every few
seconds), when it was never probed, on a refresh, or — one per poll — when
its status is past the sweep age, which is how an unfocused repo edited by
another program catches up. A "refresh status" button re-probes every
entry at once; a failed poll shows its error above the list. The status
line of a present repo uses `repos status`'s words, the reasons `repos
sync` would leave it to a person included. Only registry projects have status; the daemon
holds each registry's resolved entries while it's open, set and dropped
under the projects lock with the open and close.

## Root scope

Which directories can be roots at all — an open project's root or a scoped dir —
is one rule (Rust: `crates/zzz_server/src/root_policy.rs`), checked on the
canonical path, so no symlink or `..` spelling changes the answer:

- **Never** `/`, the home directory (`$HOME`, the daemon's, canonicalized at
  boot) or any ancestor of it, or anything under `/proc`, `/sys`, or `/dev`.
- **Otherwise strictly inside `$HOME`**, or at or inside a directory
  `ZZZ_ROOTS_OUTSIDE_HOME` names (comma-separated; an entry the first rule
  refuses fails the boot).

`project_open` (and so `zzz <path>`) answers a refused directory — the
opened one, or the project root it resolves to — with
`forbidden` / `root_outside_home` when the allowlist would admit it and
`root_not_allowed` when nothing would; a scoped dir it refuses fails the
boot. A scoped dir that doesn't exist at boot is checked as spelled — a `..`
in the spelling fails the boot — and again on its canonical path when its
filer starts, which skips it (with a warning) if that path is refused or
isn't the one the boot checked. A `$HOME` that can't be resolved, isn't a
directory, or is `/` admits nothing but the allowlist (with a boot warning). The app dir is the
operator's own and exempt from the `$HOME` rule, not from the first. So a
project can't take in the whole home directory with its dotfiles, the
whole filesystem, or `/proc/<pid>/environ`; credential directories inside
an admitted root stay refused by `ScopedFs` (./architecture.md § Zzz App
Directory).

## Filer

`FilerManager` starts one `Filer` watcher per unique directory — the app
dir, each scoped dir, and each open project's root and focused directories
(§ Projects). A registry's root is watched at its top level alone
(`FilerDepth::TopLevel`): its loose files are indexed, its subdirectories
never listed or watched — a directory appearing there isn't indexed — so a
focused repo's own filer is the only one under it. Every other filer indexes
its whole tree. Each filer keeps an in-memory file index and broadcasts
changes to clients via debounced `filer_change` notifications over
WebSocket. Each file travels as a disknode,
`{id, source_dir, size, ctime, mtime}` — metadata only: `id` is its path and
`size` its bytes from the filer's `lstat`, `null` only on a `delete`'s node.
No disknode carries contents; a client reads them with `diskfile_read` (see
[File Editing](./architecture.md#file-editing)). A snapshot — `session_load`, `project_open`,
`repo_focus`, `repo_files` — carries its files compactly instead
(`SnapshotFiles`): one `{dir, files}` group per filer dir, each file a tuple
`[rel, size, mtime, ctime?]` with its path relative to `dir` and `ctime`
left off when it equals `mtime`, which the frontend decodes back to
disknodes (`decode_snapshot_files`) — about half the bytes of the objects
for a large tree. Timestamps are whole milliseconds since the epoch. Notify
events are treated as hints: for every event, removes and renames included,
the filer `lstat`s the path and decides `add` / `change` / `delete` from the
disk and its index, so renames resolve to a delete of the old path plus an
add of the new one, and late or reordered events can't delete a file that
exists. The index is stat-only — the filer reads no file — and a file is
unchanged only when its `lstat` stamp (device, inode, size, mtime, ctime)
matches the indexed one; any other is a `change` carrying the new metadata,
a `touch` and a rewrite of the same bytes included. The stamp's `ctime` is
the inode change time (`st_ctime`), which every write, chmod, and `utimes`
moves and userspace can't set on a kernel-managed filesystem; the wire
`ctime` is the birth time. So a chmod, chown, or new hard link is a `change`
too, with the same wire metadata as before. A stamp is trusted only when its
inode change time lay more than three seconds before it was taken (git's
"racily clean" rule: same-size writes within one timestamp tick look
identical), so a file indexed while it might still have been written is a
`change` the next time an event or a rescan looks at it, even with its stamp
unmoved. An `mtime` in the future (`touch -d`, `cp -p`) doesn't matter. A
client holding the file's content reads it again if it holds it eagerly and
otherwise drops it, to load on next access (`Diskfiles.upsert`), and a
re-read of the same text changes nothing. Broadcasts are debounced per path
(80ms quiet, at most 500ms): a delete then re-create becomes one `change`,
and a file created and deleted inside the window is sent only as a `delete`
(a no-op for clients that never saw it). Ignored paths (see below) are
filtered before the event channel; if events are still dropped (or the OS
queue overflows), the filer rebuilds its watches on a fresh watcher, rescans
its root, and broadcasts the diff. Symlinks are skipped entirely — never
followed, never indexed, never watched — matching `ScopedFs`.

Watches are per directory: the filer's own walk (on a blocking thread) adds
one non-recursive watch to each directory it indexes — never inside ignored,
symlinked, or non-UTF-8 directories — watching each before listing it, so
nothing created in between is missed. A directory that appears gets watches
for its subtree when it's synced; one that's removed or renamed away has
them dropped (two paths sharing one inode, like a renamed directory's old
and new path or a bind mount, share one kernel watch, removed only with its
last path). An unreadable subdirectory is skipped and logged once, and
picked up once it's readable again; one made unreadable later drops out of
the index. A listing that fails transiently (`EMFILE`, `EIO`) keeps what's
indexed under it and retries. A walk or a rescan (`session_load`, overflow
recovery) costs one `lstat` per file and reads none, and broadcasts only the
files whose stamps moved or weren't trusted yet.

What a filer ignores is decided once, when it starts, from its root alone
(`filer::ignore`). A root whose own `.git` is a directory or a gitfile by
`lstat` — a checkout, as § Projects resolves one — indexed whole takes
**git's rule**; anything else (a plain directory, a registry's root at its
top level) keeps **fixed names**: `node_modules`, `.svelte-kit`, `target`,
and `dist`, wherever they appear. Under both, `.git`, `.zzz`, the credential
directories, and `.zzz-tmp-` staging files are never indexed, whatever a
`.gitignore` says. Under git's rule everything else is git's call: at start
the filer lists what git ignores
(`git ls-files --others --ignored --exclude-standard --directory`, every
`.gitignore`, `info/exclude`, and the user's global excludes file), confirms
each folded directory with one `git check-ignore` (git folds a directory
whose untracked contents are all ignored even when nothing names it — zzz's
own `.claude/` — so those are walked and watched, their ignored files
skipped one by one), and prunes the walk by the result. A tracked file is
never ignored, so a tracked `dist/` is indexed, and so is a `node_modules/`
no pattern names. A repo of its own below the root — a nested repo, a
populated submodule, a directory whose `.git` is a symlink — is neither
walked nor indexed. Every listing is taken twice, around its walk, so what
was created in between is listed rather than indexed unvetted. Live, a burst
of events that adds paths not yet indexed asks one `check-ignore` about them
before they're indexed — up to 128 paths; git's check costs per path about
what reading its index does, so past that a rebuild of the set (below) is
cheaper on a large tree — and a new directory git doesn't ignore has its own
ignored paths listed before its walk; a `.gitignore` changing anywhere under
the root or `.git/info/exclude` changing (watched by the filer's own
watcher, for a root whose `.git` is a directory) rebuilds the set and
rescans once the changes settle (400 ms of quiet, at most 5 s), so a
checkout's intermediate states aren't applied one by one, and lost events do
so at once — removing what's newly ignored and adding what no longer is. git
runs with the daemon's allowlisted environment, its discovery ceilinged at
the root's parent, implicit bare repos refused, and short timeouts (5 s per
listing call, 2 s per vetting call), after re-checking that the root is
still the real directory it was. When git is unusable or its first listing
fails, the filer keeps fixed names; a later listing that fails keeps the
last set until the next rebuild — a `.gitignore` or `info/exclude` change,
lost events, or, while the last rebuild failed, the next `session_load`
rescan or degraded poll — and the filer keeps fixed names for the rest of
its life once three rebuilds in a row that a change on disk asked for fail —
a `.gitignore` or `info/exclude` change, lost events, new files git couldn't
vet, or a set grown past its budget (a load's or poll's retry failing
doesn't count) — or at once when the root is no longer the checkout it was
(swapped for a symlink).

When the OS runs out of watches (inotify's `max_user_watches`), or no
watcher can be created at all (`max_user_instances`), the filer runs
**degraded**: the index still comes from the scan, and the directories
without a watch are rescanned every 5 seconds or more (retrying their
watches each time), so changes there show up late. `project_open` returns
this as `watch_status` (`'full'` or `'degraded'`, degraded when any of the
project's filers is), which the tab that opened it keeps on its `Project`
cell and shows on the projects page and in the desk menu. It's reported at
open time only (another tab or a reload shows `'full'`) — a filer that
degrades or recovers later is just logged. A project root or focused
directory that can't be listed fails `project_open` (`forbidden` /
`permission_denied`, or `not_found`); a running filer whose root disappears
polls it until it's back.

## Known limitations

The limits of projects, focus, and the filer; the app's other limits are
./architecture.md § Known Limitations.

- **Projects and focus** — focus is by hand: a repo is indexed only once
  it's focused (opening a path in it, the file tree's lazy row, the
  projects page), and stays focused until it's unfocused, its project
  closes, or a later open finds its entry missing or the root's kind
  changed. Under a registry's root the registry's project indexes only
  its loose files and its focused repos — an unregistered directory only
  as its own project, once a path in it is opened. A new file where
  nothing indexes it is refused, since it would never show; a file another
  tool creates there doesn't appear. A registry's entries are
  resolved when it's opened, again on each later open, never in between —
  so `repo_focus` of an entry cloned since refuses it until a path in it
  is opened. A file kept from an unfocused repo for its draft or tab
  isn't watched: a change on disk meanwhile shows only when the repo is
  focused again, or as a conflict when it's saved
- **Project scope** — opening a project makes its root a writable
  `ScopedFs` root, with filers on what's focused, until it's closed; closing
  never revokes
  the permanent roots (`PUBLIC_ZZZ_DIR` and `PUBLIC_ZZZ_SCOPED_DIRS`). A
  directory strictly inside `$HOME`, or in `ZZZ_ROOTS_OUTSIDE_HOME`, can be
  opened — never `/`, `$HOME` or an ancestor of it, or a pseudo-filesystem
  (§ Root scope) — and no root makes a credential directory or a `.zzz`
  directory other than the app dir readable or writable. A project opened
  in another tab (or by `zzz <path>`) appears here unactivated, and its files
  arrive with a session resync
- **Large trees cost the client** — every indexed file of a focused repo
  ships in the focus reply and is kept as a metadata record
  (`DiskfileIndex`); a `Diskfile` cell is made only for a file in use (see
  ./architecture.md § File Editing), so focusing a big clone costs the reply's size and
  parse more than the cells, and a reply of roughly 180k files passes the
  16 MiB message size (replies aren't capped, so it still arrives). A re-prune past the
  flood guard costs each client the same pull of the whole repo
- **File watching** — the filer adds one inotify watch per directory it
  indexes (never inside ignored directories), and those watches come out of
  the user's `max_user_watches` budget, shared with every other process. An
  unreadable subdirectory is skipped (logged once) and picked up if it
  becomes readable; an unreadable root or focused directory fails
  `project_open` with `forbidden` (`permission_denied`). When the watch
  limit is reached (or no watcher can be created), the project still opens
  with every file the scans found, but in **degraded mode**: `project_open`
  returns `watch_status: 'degraded'` (kept on the opening tab's `Project`
  cell; the projects page and the desk menu show it — another tab or a
  reload shows `'full'`), and the directories without a watch are rescanned
  every 5 seconds or more (retrying their watches each time), so changes
  there show up late. A project that degrades or recovers after it opened
  isn't re-announced — only the daemon log says so. A file is re-announced
  as changed when its `lstat` stamp moves (a `touch` or a chmod included, so
  clients holding it read it again), and once more at the next look after a
  change seen within 3 seconds of its inode change time (a stamp that fresh
  isn't trusted)
- **Change detection is by stat stamp** — the filer reads no file, so a
  write that doesn't move the file's `lstat` stamp goes unnoticed until the
  stamp next moves: an `mmap` store to an already-dirty page, or a remote or
  FUSE filesystem whose server clock lags this machine's by more than the
  3-second margin, or a FUSE filesystem that reports `st_ctime` as the
  `mtime` (sshfs), where a `touch -r` after a same-size rewrite hides it. A
  wall clock stepped back by more than the margin can hide a write that
  lands in the same timestamp tick as the stored stamp. An inode change time
  in the future (a clock stepped back, a remote server's clock ahead) is
  never trusted, so the file is a `change` on every look until the clock
  passes it
- **Git's ignore rule** (§ Filer) — what a checkout's filer ignores is
  git's answer as of its last listing plus the paths it vetted since: the
  user's global excludes file isn't watched (an edit there shows at the next
  re-prune), nor is `info/exclude` for a linked worktree or a submodule's
  checkout (its common directory is named only by the repo's own files,
  which the filer doesn't follow). A `.git` appearing in an indexed
  directory drops it from the index; one removed from a directory that
  wasn't indexed shows only at the next rescan. A directory whose `.git`
  is a symlink is indexed by no filer: git lists nothing in it, and a path
  in it resolves to the outer checkout. A file created by hand inside an
  unpopulated submodule makes git refuse the burst's check; that submodule
  is then left unindexed, as a populated one is, until the next rebuild of
  the set. A file git ignores replaced by a directory it doesn't (a
  `.gitignore` naming `x` and `!x/`) stays skipped as the file was; the
  directory is picked up at the next rebuild of the set or rescan. A
  rebuild whose listing fails or times out leaves the change it was for
  unapplied — and a new file git couldn't vet meanwhile unindexed — until
  the next `session_load` (a reload or a reconnect) or degraded poll
  rebuilds the set again; three failing in a row that a change on disk
  asked for (a rule edit, lost events, new files git couldn't vet, a set
  grown past its budget) fall back to fixed names, but a load's or poll's
  retry failing doesn't count, so a git that never answers costs a
  listing's timeout (5 s) per degraded poll and per load until such
  changes fail too — on a quiet degraded tree, possibly never. Each load
  waits out the 5 s with the filer blocked; polls back off to about 50 s
  apart (ten times their own duration, roughly a 10% duty cycle).
  Any `.git` entry — even one git wouldn't read as a repo — makes its
  directory a repo of its own here, so its files aren't indexed; the wire
  names it (`nested`), so a link into one reads "not indexed" and a file
  created there isn't waited for. A `.git` removed from a nested repo is
  seen only at the next rescan (no watch is inside it), so until then its
  files stay unindexed and it stays `nested`. A permanent filer on a
  checkout (the app directory, a scoped dir) runs git's rule, but its set
  is off the wire unless a project focuses it, so the frontend holds it to
  fixed names — a tracked `dist/` in it is indexed but hidden in the tree,
  and a file git ignores there reads as broken in a link, and is waited
  for, without a notice, when created. What the wire says is ignored can lag
  a second behind the filer (refreshes are coalesced), and a re-prune
  resynced while its project closes and a permanent filer stays on the
  directory leaves clients' permanent copy of it stale until the next
  `session_load`; and a filer started by a focus scan before the lock is
  off the wire until its commit marks it, so a re-prune past the threshold
  in that window sends each change

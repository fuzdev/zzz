//! Whether a file or directory is the daemon user's alone to write.
//!
//! The rule for honoring configuration that a path discovers rather than
//! one the operator names, such as a `repos.toml` found above an opened
//! directory ([`crate::project`]).
//!
//! The rule is OpenSSH's on Debian (its `user-group-modes` patch to
//! `secure_permissions`), which judges `~/.ssh/authorized_keys` and the
//! directories above it the same way. An inode is trusted when:
//!
//! - it is **owned by the daemon's uid or by root** (uid 0, as sshd's
//!   `platform_sys_dir_uid` allows: root can write anything anyway, and a
//!   root-owned directory such as an allowlisted `/srv` is no one else's);
//! - it is **not writable by others** (`o+w`);
//! - it is **group-writable** (`g+w`) only when its group is the user's
//!   **private group**: named as the user, the user's primary group, with no
//!   other member ([`private_group`]).
//!
//! The private-group exception is what Debian's user-private-group scheme
//! needs: a umask of `002` makes `~/dev` `775` and a `repos.toml` `664`,
//! writable only by a group that holds the user alone.
//!
//! The mode rules hold for a root-owned inode as for the user's own: root's
//! `o+w`, or `g+w` by a group other than the user's private one, is refused.
//!
//! [`TrustedOwner::current`] reads the account databases once, at the edge;
//! the predicate itself ([`TrustedOwner::check`]) is pure over what that
//! read found, so tests inject the uid and the private group.

use std::os::unix::fs::MetadataExt as _;

/// The passwd file read for primary-group members ([`private_group`]), the
/// `files` NSS backend's database.
const PASSWD_FILE: &str = "/etc/passwd";

/// The largest passwd file read; a larger one leaves no private group.
const PASSWD_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// root's uid, whose inodes are trusted as the user's are.
const ROOT_UID: u32 = 0;

/// The owners a trusted inode may have, and the one group that may write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedOwner {
    uid: u32,
    /// root's uid ([`ROOT_UID`]); only tests, which can't `chown` to root,
    /// name another (`with_root_uid`).
    root_uid: u32,
    /// The user's private group ([`private_group`]), or `None` when it has
    /// none — then no group-writable inode is trusted.
    private_gid: Option<u32>,
}

impl TrustedOwner {
    /// An owner from what the caller already knows: the uid, and the gid of
    /// the user's private group if it has one.
    pub const fn new(uid: u32, private_gid: Option<u32>) -> Self {
        Self {
            uid,
            root_uid: ROOT_UID,
            private_gid,
        }
    }

    /// This owner with `root_uid` standing in for root's, so a test's own
    /// files read as root-owned without a `chown` only root can make.
    #[cfg(test)]
    pub(crate) const fn with_root_uid(self, root_uid: u32) -> Self {
        Self { root_uid, ..self }
    }

    /// The daemon's own user: its effective uid, and its private group as
    /// NSS and the passwd file describe it ([`private_group`]).
    ///
    /// Reads, through NSS, the user's entry (`getpwuid_r`: name and primary
    /// gid) and the primary group's (`getgrgid_r`: name and member list),
    /// and scans `/etc/passwd` for another user with the same primary
    /// gid. NSS has no enumeration this crate can call without `unsafe`
    /// (`getpwent`), so that scan sees the `files` backend only: a user from
    /// a directory service (LDAP, sssd) whose primary group is this one goes
    /// unseen. Any failed lookup leaves no private group, so a failure only
    /// refuses more.
    pub fn current() -> Self {
        let uid = nix::unistd::geteuid().as_raw();
        Self::new(uid, lookup_private_gid(uid))
    }

    /// The daemon user's uid, which owns a trusted inode unless root does.
    pub const fn uid(&self) -> u32 {
        self.uid
    }

    /// Whether `inode` is trusted (see the module docs).
    ///
    /// # Errors
    ///
    /// The [`Untrusted`] naming the first rule it breaks: its owner (neither
    /// the user nor root), then `o+w`, then `g+w` by a group other than the
    /// private one.
    pub fn check(&self, inode: Inode) -> Result<(), Untrusted> {
        if ![self.uid, self.root_uid].contains(&inode.uid) {
            return Err(Untrusted::NotOwned {
                uid: inode.uid,
                expected: self.uid,
            });
        }
        if inode.mode & 0o002 != 0 {
            return Err(Untrusted::WorldWritable {
                mode: inode.mode & 0o7777,
            });
        }
        if inode.mode & 0o020 != 0 && self.private_gid != Some(inode.gid) {
            return Err(Untrusted::GroupWritable {
                gid: inode.gid,
                mode: inode.mode & 0o7777,
            });
        }
        Ok(())
    }
}

/// What [`TrustedOwner::check`] reads of an inode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inode {
    pub uid: u32,
    pub gid: u32,
    /// The mode bits (`st_mode`); only the permission bits are read.
    pub mode: u32,
}

impl From<&std::fs::Metadata> for Inode {
    fn from(meta: &std::fs::Metadata) -> Self {
        Self {
            uid: meta.uid(),
            gid: meta.gid(),
            mode: meta.mode(),
        }
    }
}

/// Why an inode isn't trusted ([`TrustedOwner::check`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Untrusted {
    /// Owned by someone other than the daemon's user or root.
    #[error("is owned by uid {uid}, neither the daemon's uid {expected} nor root")]
    NotOwned { uid: u32, expected: u32 },
    /// Writable by others (`o+w`).
    #[error("is writable by others (mode {mode:o})")]
    WorldWritable { mode: u32 },
    /// Group-writable by a group that isn't the user's private group.
    #[error(
        "is writable by group {gid}, which isn't the daemon user's private group (mode {mode:o})"
    )]
    GroupWritable { gid: u32, mode: u32 },
}

/// A user's passwd entry, as far as [`private_group`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserEntry {
    pub uid: u32,
    pub name: String,
    /// The primary group (`pw_gid`).
    pub gid: u32,
}

/// A group's entry, as far as [`private_group`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEntry {
    pub gid: u32,
    pub name: String,
    /// The supplementary members (`gr_mem`).
    pub members: Vec<String>,
}

/// The gid of `user`'s private group, if `group` is one.
///
/// It is when `group` is the user's primary group (`gid`), is named as the
/// user, lists no supplementary member but the user, and no other passwd
/// entry in `passwd` (the text of a passwd file) has it as its primary
/// group. Debian's sshd checks the last two as one count of members; the
/// name rule is this crate's own, after Debian's user-private-group scheme
/// (`adduser` names the group as the user).
pub fn private_group(user: &UserEntry, group: &GroupEntry, passwd: &str) -> Option<u32> {
    let private = group.gid == user.gid
        && group.name == user.name
        && group.members.iter().all(|m| *m == user.name)
        && !passwd_shares_primary_gid(passwd, user);
    private.then_some(group.gid)
}

/// Whether a passwd entry other than `user` (by uid or name) has `user`'s
/// primary gid as its own. A malformed line counts as one — refuse, don't
/// guess — unless it is blank or a comment.
fn passwd_shares_primary_gid(passwd: &str, user: &UserEntry) -> bool {
    passwd
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .any(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            let (Some(name), Some(uid), Some(gid)) = (
                fields.first(),
                fields.get(2).and_then(|u| u.parse::<u32>().ok()),
                fields.get(3).and_then(|g| g.parse::<u32>().ok()),
            ) else {
                return true;
            };
            gid == user.gid && (uid != user.uid || *name != user.name)
        })
}

/// [`private_group`] over the live account databases ([`TrustedOwner::current`]).
fn lookup_private_gid(uid: u32) -> Option<u32> {
    use std::io::Read as _;

    let user = nix::unistd::User::from_uid(nix::unistd::Uid::from_raw(uid)).ok()??;
    let group = nix::unistd::Group::from_gid(user.gid).ok()??;
    let (file, _) =
        fuz_sys::secure_file::open_regular_nonblocking(std::path::Path::new(PASSWD_FILE)).ok()?;
    let mut passwd = String::new();
    file.take(PASSWD_MAX_BYTES + 1)
        .read_to_string(&mut passwd)
        .ok()?;
    if passwd.len() as u64 > PASSWD_MAX_BYTES {
        return None;
    }
    private_group(
        &UserEntry {
            uid,
            name: user.name,
            gid: user.gid.as_raw(),
        },
        &GroupEntry {
            gid: group.gid.as_raw(),
            name: group.name,
            members: group.mem,
        },
        &passwd,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: u32 = 1000;
    const GID: u32 = 1000;

    fn inode(uid: u32, gid: u32, mode: u32) -> Inode {
        Inode { uid, gid, mode }
    }

    #[test]
    fn owned_and_unwritable_by_others_is_trusted() {
        let owner = TrustedOwner::new(UID, None);
        for mode in [0o100_644, 0o040_755, 0o100_600, 0o040_700, 0o100_444] {
            assert_eq!(owner.check(inode(UID, GID, mode)), Ok(()), "{mode:o}");
        }
    }

    #[test]
    fn another_owner_is_refused_whatever_the_mode() {
        let owner = TrustedOwner::new(UID, Some(GID));
        for uid in [1, UID - 1, UID + 1] {
            assert_eq!(
                owner.check(inode(uid, GID, 0o100_600)),
                Err(Untrusted::NotOwned { uid, expected: UID })
            );
        }
    }

    #[test]
    fn root_owned_is_trusted_under_the_same_mode_rules() {
        let owner = TrustedOwner::new(UID, Some(GID));
        for mode in [0o040_755, 0o100_644, 0o100_600] {
            assert_eq!(owner.check(inode(0, 0, mode)), Ok(()), "{mode:o}");
        }
        // root's group-writable inode in the user's private group
        assert_eq!(owner.check(inode(0, GID, 0o040_775)), Ok(()));
        // root's `o+w` (a sticky `/tmp`), or `g+w` by root's own group
        assert_eq!(
            owner.check(inode(0, 0, 0o041_777)),
            Err(Untrusted::WorldWritable { mode: 0o1777 })
        );
        assert_eq!(
            owner.check(inode(0, 0, 0o040_775)),
            Err(Untrusted::GroupWritable {
                gid: 0,
                mode: 0o775
            })
        );
    }

    #[test]
    fn writable_by_others_is_refused_even_in_the_private_group() {
        let owner = TrustedOwner::new(UID, Some(GID));
        for mode in [0o100_646, 0o040_777, 0o040_757, 0o041_777] {
            assert_eq!(
                owner.check(inode(UID, GID, mode)),
                Err(Untrusted::WorldWritable {
                    mode: mode & 0o7777
                }),
                "{mode:o}"
            );
        }
    }

    #[test]
    fn group_writable_is_trusted_only_for_the_private_group() {
        let private = TrustedOwner::new(UID, Some(GID));
        assert_eq!(private.check(inode(UID, GID, 0o040_775)), Ok(()));
        assert_eq!(private.check(inode(UID, GID, 0o100_664)), Ok(()));
        // a group-writable inode in another group
        assert_eq!(
            private.check(inode(UID, 27, 0o040_775)),
            Err(Untrusted::GroupWritable {
                gid: 27,
                mode: 0o775
            })
        );
        // no private group: no group-writable inode is trusted
        let none = TrustedOwner::new(UID, None);
        assert_eq!(
            none.check(inode(UID, GID, 0o100_664)),
            Err(Untrusted::GroupWritable {
                gid: GID,
                mode: 0o664
            })
        );
        // but group-readable is fine
        assert_eq!(none.check(inode(UID, 27, 0o040_750)), Ok(()));
    }

    fn user() -> UserEntry {
        UserEntry {
            uid: UID,
            name: "me".to_owned(),
            gid: GID,
        }
    }

    fn group(name: &str, members: &[&str]) -> GroupEntry {
        GroupEntry {
            gid: GID,
            name: name.to_owned(),
            members: members.iter().map(|m| (*m).to_owned()).collect(),
        }
    }

    const PASSWD: &str = "root:x:0:0:root:/root:/bin/bash\n\
        # a comment\n\
        \n\
        me:x:1000:1000:Me,,,:/home/me:/bin/bash\n\
        other:x:1001:1001::/home/other:/bin/sh\n";

    #[test]
    fn a_group_named_as_the_user_with_no_one_else_is_private() {
        assert_eq!(private_group(&user(), &group("me", &[]), PASSWD), Some(GID));
        // the user listed as its own supplementary member is still alone
        assert_eq!(
            private_group(&user(), &group("me", &["me"]), PASSWD),
            Some(GID)
        );
    }

    #[test]
    fn a_shared_group_is_not_private() {
        // another supplementary member
        assert_eq!(
            private_group(&user(), &group("me", &["me", "other"]), PASSWD),
            None
        );
        assert_eq!(
            private_group(&user(), &group("me", &["other"]), PASSWD),
            None
        );
        // named otherwise (`users`, `staff`)
        assert_eq!(private_group(&user(), &group("users", &[]), PASSWD), None);
        // not the user's primary group
        let other_gid = GroupEntry {
            gid: 100,
            ..group("me", &[])
        };
        assert_eq!(private_group(&user(), &other_gid, PASSWD), None);
        // another user's primary group too
        let shared = format!("{PASSWD}guest:x:1002:1000::/home/guest:/bin/sh\n");
        assert_eq!(private_group(&user(), &group("me", &[]), &shared), None);
        // the user's name on another uid
        let alias = format!("{PASSWD}me:x:0:1000::/root:/bin/sh\n");
        assert_eq!(private_group(&user(), &group("me", &[]), &alias), None);
    }

    #[test]
    fn a_malformed_passwd_line_refuses_the_private_group() {
        for line in ["garbage", "x:x:notanumber:1000", "y:x:5"] {
            let passwd = format!("{PASSWD}{line}\n");
            assert_eq!(
                private_group(&user(), &group("me", &[]), &passwd),
                None,
                "{line}"
            );
        }
    }

    #[test]
    fn the_current_user_is_the_effective_uid() {
        let owner = TrustedOwner::current();
        assert_eq!(owner.uid(), nix::unistd::geteuid().as_raw());
        // whatever the machine's groups, a file this process creates is its own
        let path =
            std::env::temp_dir().join(format!("zzz_file_trust_test_{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "x").unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(Inode::from(&meta).uid, owner.uid());
    }
}

//! Linux `/proc` probes for daemon identity.
//!
//! A bare pid is not an identity: pids are reused, and a port answering
//! `/health` may belong to any process. The CLI identifies its daemon by
//! **boot id + pid + kernel start time** (field 22 of `/proc/<pid>/stat`,
//! which differs between two processes that ever share a pid within a boot;
//! the boot id rules out a record that survived a reboot), and confirms a
//! freshly spawned daemon by checking that the child itself holds the
//! listening socket on the expected port.
//!
//! Everything here reads `/proc` and fails closed: an unreadable entry
//! means "not identified", never "identified".

use std::fs;
use std::path::Path;

/// This boot's id (`/proc/sys/kernel/random/boot_id`), or `None` when
/// unreadable.
#[must_use]
pub fn boot_id() -> Option<String> {
    let id = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let id = id.trim();
    (!id.is_empty()).then(|| id.to_owned())
}

/// Kernel start time of `pid` in clock ticks since boot, or `None` when the
/// process is gone, is a zombie, or `/proc` is unreadable.
#[must_use]
pub fn process_start_ticks(pid: u32) -> Option<u64> {
    read_stat(pid)
        .filter(|stat| !stat.zombie)
        .map(|stat| stat.start_ticks)
}

/// Kernel start time of `pid`, zombie or not — for a child the caller has
/// just spawned and not yet reaped (its pid can't have been reused), which
/// may already have exited.
#[must_use]
pub fn child_start_ticks(pid: u32) -> Option<u64> {
    read_stat(pid).map(|stat| stat.start_ticks)
}

/// The fields of `/proc/<pid>/stat` the identity checks use.
#[derive(Debug, PartialEq, Eq)]
struct Stat {
    /// State `Z` / `X`: exited, not yet reaped (or being reaped).
    zombie: bool,
    /// Field 22, `starttime`.
    start_ticks: u64,
}

fn read_stat(pid: u32) -> Option<Stat> {
    parse_stat(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// Parse a `/proc/<pid>/stat` line.
///
/// Field 2 (`comm`) is parenthesized and may itself contain spaces and `)`,
/// so fields are counted from the **last** `)`.
fn parse_stat(stat: &str) -> Option<Stat> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    // field 3: state
    let zombie = matches!(fields.next()?, "Z" | "X" | "x");
    // fields 4..=21 skipped, field 22: starttime
    let start_ticks = fields.nth(18)?.parse().ok()?;
    Some(Stat {
        zombie,
        start_ticks,
    })
}

/// Whether `pid` holds a TCP socket listening on `port`.
///
/// Matches the socket inodes of `LISTEN` entries in `/proc/net/tcp{,6}`
/// against the `socket:[inode]` links in `/proc/<pid>/fd`. Only processes the
/// caller may inspect (its own user's) can match.
#[must_use]
pub fn pid_listens_on(pid: u32, port: u16) -> bool {
    let inodes: Vec<u64> = ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .filter_map(|table| fs::read_to_string(table).ok())
        .flat_map(|table| parse_listening_inodes(&table, port))
        .collect();
    if inodes.is_empty() {
        return false;
    }
    let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    fds.flatten().any(|fd| {
        fs::read_link(fd.path())
            .ok()
            .and_then(|target| socket_inode(&target))
            .is_some_and(|inode| inodes.contains(&inode))
    })
}

/// Inodes of the `LISTEN` (`st == 0A`) sockets bound to `port` in a
/// `/proc/net/tcp` / `tcp6` table.
fn parse_listening_inodes(table: &str, port: u16) -> Vec<u64> {
    table
        .lines()
        .skip(1) // header
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let local = fields.get(1)?;
            if *fields.get(3)? != "0A" {
                return None;
            }
            let (_, local_port) = local.rsplit_once(':')?;
            if u16::from_str_radix(local_port, 16).ok()? != port {
                return None;
            }
            fields.get(9)?.parse().ok().filter(|&inode| inode != 0)
        })
        .collect()
}

/// The inode of a `socket:[inode]` fd link target.
fn socket_inode(target: &Path) -> Option<u64> {
    target
        .to_str()?
        .strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    const fn stat(zombie: bool, start_ticks: u64) -> Stat {
        Stat {
            zombie,
            start_ticks,
        }
    }

    #[test]
    fn parses_start_ticks_from_stat() {
        let line = "4242 (zzzd) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 8 0 987654 1000000 500 18446744073709551615";
        assert_eq!(parse_stat(line), Some(stat(false, 987_654)));
    }

    #[test]
    fn stat_comm_with_spaces_and_parens_is_skipped() {
        let line = "7 (a) b (c)) R 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 55 0 0";
        assert_eq!(parse_stat(line), Some(stat(false, 55)));
    }

    #[test]
    fn zombie_and_malformed_stat() {
        let zombie = "9 (zzzd) Z 1 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 77 0 0";
        assert_eq!(parse_stat(zombie), Some(stat(true, 77)));
        assert_eq!(parse_stat("no parens here"), None);
        assert_eq!(parse_stat("1 (short) S 1 2"), None);
    }

    #[test]
    fn an_exited_unreaped_child_keeps_its_start_ticks() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        // wait for the exit without reaping: the pid becomes a zombie
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while process_start_ticks(pid).is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(process_start_ticks(pid), None, "a zombie is not alive");
        assert!(
            child_start_ticks(pid).is_some(),
            "but its identity is readable"
        );
        child.wait().unwrap();
    }

    #[test]
    fn boot_id_is_stable() {
        let id = boot_id().expect("readable boot id");
        assert_eq!(id.len(), 36, "{id}");
        assert_eq!(boot_id().as_deref(), Some(id.as_str()));
    }

    #[test]
    fn own_process_has_stable_start_ticks() {
        let me = std::process::id();
        let first = process_start_ticks(me).expect("own /proc entry");
        assert_eq!(process_start_ticks(me), Some(first));
        assert_eq!(process_start_ticks(4_000_000_000), None);
    }

    #[test]
    fn parses_listening_inodes_for_port() {
        // 0x1170 = 4464; 0x1171 = 4465
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1170 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0
   1: 0100007F:1170 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 20 4 30 10 -1
   2: 00000000:1171 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 100 0 0 10 0
   3: 0100007F:1170 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0 100 0 0 10 0";
        assert_eq!(parse_listening_inodes(table, 4464), vec![111]);
        assert_eq!(parse_listening_inodes(table, 4465), vec![333]);
        assert!(parse_listening_inodes(table, 4466).is_empty());
    }

    #[test]
    fn parses_socket_inode_links() {
        assert_eq!(socket_inode(Path::new("socket:[12345]")), Some(12_345));
        assert_eq!(socket_inode(Path::new("pipe:[12345]")), None);
        assert_eq!(socket_inode(Path::new("/dev/null")), None);
    }

    #[test]
    fn detects_own_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        assert!(pid_listens_on(me, port));
        drop(listener);
        assert!(!pid_listens_on(me, port));
    }
}

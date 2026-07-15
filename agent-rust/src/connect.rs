//! Self-configuring "connect" launch.
//!
//! When the agent is started with **no subcommand** — e.g. an end user
//! double-clicks it after downloading from the connect page — it reads its own
//! file name to discover which server to talk to and the one-time session code,
//! so the user never types anything into a terminal.
//!
//! The connect page (`connect.<domain>/dl?code=NNNNNNNNN`) serves the generic,
//! CI-built agent binary under a name shaped like:
//!
//! ```text
//! RemoteSupport--connect.tiefixy.com--123456789.exe
//! ```
//!
//! i.e. `RemoteSupport--<host>--<code>.exe`. From that we derive
//! `https://<host>` / `wss://<host>` and the code, then run the normal attended
//! join. Nothing secret is embedded: the code is single-use and short-lived, and
//! the host is public.

/// Server host + one-time code recovered from a connect download file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectParams {
    pub host: String,
    pub code: String,
}

const PREFIX: &str = "RemoteSupport--";
const SEP: &str = "--";

/// Parse the server host and one-time code out of a connect download file name.
///
/// Returns `None` for any name that is not a connect download (e.g. a
/// user-renamed binary), so the caller can fall back to prompting.
///
/// Tolerant of:
/// * an optional `.exe` suffix, any letter case;
/// * the trailing ` (1)`, ` (2)`, … a browser appends to duplicate downloads;
/// * surrounding whitespace and a leading directory path.
pub fn parse_connect_filename(file_name: &str) -> Option<ConnectParams> {
    // Keep only the base name if a full path slipped in.
    let base = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_name)
        .trim();

    // Drop a trailing ".exe" (case-insensitive).
    let base = strip_suffix_ci(base, ".exe").unwrap_or(base);

    // Drop a trailing " (n)" duplicate-download marker.
    let base = strip_dup_suffix(base);

    // Require the marker prefix (case-insensitive).
    let rest = strip_prefix_ci(base, PREFIX)?;

    // rest == "<host>--<code>". The code never contains "--", so split on the
    // last "--" — that keeps working even if a host somehow contained one.
    let idx = rest.rfind(SEP)?;
    let host = rest[..idx].trim();
    let code = rest[idx + SEP.len()..].trim();

    if !is_plausible_host(host) {
        return None;
    }
    if code.is_empty() || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    Some(ConnectParams {
        host: host.to_string(),
        code: code.to_string(),
    })
}

fn strip_suffix_ci<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    let n = s.len();
    let m = suffix.len();
    if n >= m && s[n - m..].eq_ignore_ascii_case(suffix) {
        Some(&s[..n - m])
    } else {
        None
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let m = prefix.len();
    if s.len() >= m && s[..m].eq_ignore_ascii_case(prefix) {
        Some(&s[m..])
    } else {
        None
    }
}

/// Strip a trailing ` (123)` duplicate-download marker, if present.
fn strip_dup_suffix(s: &str) -> &str {
    let t = s.trim_end();
    if t.ends_with(')') {
        if let Some(open) = t.rfind(" (") {
            let inner = &t[open + 2..t.len() - 1];
            if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                return t[..open].trim_end();
            }
        }
    }
    t
}

/// Conservative hostname check: letters, digits, dots and hyphens only, with at
/// least one dot so it reads like a real domain rather than a stray token.
fn is_plausible_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.contains('.')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(name: &str, host: &str, code: &str) {
        assert_eq!(
            parse_connect_filename(name),
            Some(ConnectParams {
                host: host.to_string(),
                code: code.to_string(),
            }),
            "parsing {name:?}"
        );
    }

    #[test]
    fn parses_canonical_name() {
        ok(
            "RemoteSupport--connect.tiefixy.com--123456789.exe",
            "connect.tiefixy.com",
            "123456789",
        );
    }

    #[test]
    fn tolerates_duplicate_download_suffix() {
        ok(
            "RemoteSupport--connect.tiefixy.com--123456789 (1).exe",
            "connect.tiefixy.com",
            "123456789",
        );
        ok(
            "RemoteSupport--connect.tiefixy.com--123456789 (12).exe",
            "connect.tiefixy.com",
            "123456789",
        );
    }

    #[test]
    fn tolerates_case_and_path_and_no_extension() {
        ok(
            "remotesupport--connect.tiefixy.com--000000001.EXE",
            "connect.tiefixy.com",
            "000000001",
        );
        ok(
            "C:\\Users\\ronno\\Downloads\\RemoteSupport--connect.tiefixy.com--555555555.exe",
            "connect.tiefixy.com",
            "555555555",
        );
        ok(
            "RemoteSupport--connect.tiefixy.com--777777777",
            "connect.tiefixy.com",
            "777777777",
        );
    }

    #[test]
    fn rejects_non_connect_names() {
        assert_eq!(parse_connect_filename("remote-agent.exe"), None);
        assert_eq!(parse_connect_filename("setup.exe"), None);
        assert_eq!(parse_connect_filename(""), None);
        // Missing code.
        assert_eq!(
            parse_connect_filename("RemoteSupport--connect.tiefixy.com--.exe"),
            None
        );
        // Non-digit code.
        assert_eq!(
            parse_connect_filename("RemoteSupport--connect.tiefixy.com--12ab6789.exe"),
            None
        );
        // Host without a dot is not plausible.
        assert_eq!(
            parse_connect_filename("RemoteSupport--localhost--123456789.exe"),
            None
        );
        // No separator between host and code.
        assert_eq!(
            parse_connect_filename("RemoteSupport--connect.tiefixy.com123456789.exe"),
            None
        );
    }

    #[test]
    fn derives_urls_from_host() {
        let p = parse_connect_filename("RemoteSupport--connect.tiefixy.com--123456789.exe")
            .expect("parses");
        assert_eq!(format!("https://{}", p.host), "https://connect.tiefixy.com");
        assert_eq!(format!("wss://{}", p.host), "wss://connect.tiefixy.com");
    }
}

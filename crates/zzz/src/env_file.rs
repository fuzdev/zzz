//! Minimal dotenv parser.
//!
//! Std-only, so `crates/xtask` compiles this same file (via `#[path]`): the
//! CLI and the dev tooling parse `.env` files the same way. They merge the
//! result with the process environment by opposite rules, each in its own
//! caller: the `zzz` CLI lets the process env win over `~/.zzz/.env` (the
//! file fills gaps), while `cargo xtask dev` lets `.env.development` win (the
//! dev file is the source of truth) and reports each key it overrides. In
//! both, a blank value is unset — it neither fills nor overrides.
//!
//! Accepted syntax, one assignment per line:
//!
//! - a leading UTF-8 byte-order mark is ignored
//! - blank lines and `#` comment lines are skipped
//! - an optional `export ` prefix is ignored (`export KEY=value`)
//! - the key must be an identifier (`[A-Za-z_][A-Za-z0-9_]*`)
//! - `"double quoted"` values unescape `\n`, `\"`, and `\\`
//! - `'single quoted'` values are literal
//! - unquoted values are trimmed and end at a `#` preceded by whitespace
//!
//! Any other line is skipped and reported by line number in
//! [`ParsedEnv::skipped_lines`] (callers warn without echoing the line, which
//! may hold a secret).
//!
//! Where it diverges from the `dotenv` family: no `${VAR}` expansion (values
//! are literal), no multi-line values, a `#` only starts an inline comment
//! after whitespace (`KEY=a#b` keeps `a#b`), double quotes unescape only the
//! three sequences above, and malformed lines are skipped, not errors.

/// The result of parsing an env file.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedEnv {
    /// `(key, value)` assignments in file order.
    pub vars: Vec<(String, String)>,
    /// 1-based numbers of the non-blank, non-comment lines that weren't a
    /// valid assignment.
    pub skipped_lines: Vec<usize>,
}

/// Parse `.env` file contents.
#[must_use]
pub fn parse_env(contents: &str) -> ParsedEnv {
    let contents = contents.strip_prefix('\u{feff}').unwrap_or(contents);
    let mut parsed = ParsedEnv::default();
    for (index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        match parse_env_line(trimmed) {
            Some(pair) => parsed.vars.push(pair),
            None => parsed.skipped_lines.push(index + 1),
        }
    }
    parsed
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let line = line
        .strip_prefix("export")
        .filter(|rest| rest.starts_with([' ', '\t']))
        .map_or(line, str::trim_start);
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    let mut chars = key.chars();
    let valid_key = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid_key {
        return None;
    }
    Some((key.to_owned(), parse_value(value.trim())))
}

fn parse_value(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix('"') {
        let mut out = String::with_capacity(rest.len());
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return out,
                '\\' => match chars.next() {
                    Some('n') => out.push('\n'),
                    Some(escaped @ ('"' | '\\')) => out.push(escaped),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                },
                _ => out.push(c),
            }
        }
        // unterminated quote — keep the raw text rather than guess
        return raw.to_owned();
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        return rest
            .split_once('\'')
            .map_or_else(|| raw.to_owned(), |(value, _)| value.to_owned());
    }
    let end = raw
        .char_indices()
        .find(|&(i, c)| c == '#' && raw[..i].ends_with([' ', '\t']))
        .map_or(raw.len(), |(i, _)| i);
    raw[..end].trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(
        clippy::unnecessary_wraps,
        reason = "matches `parse_env_line`'s return type for direct comparison"
    )]
    fn pair(key: &str, value: &str) -> Option<(String, String)> {
        Some((key.to_owned(), value.to_owned()))
    }

    #[test]
    fn skips_blanks_comments_and_invalid_keys() {
        assert_eq!(parse_env_line(""), None);
        assert_eq!(parse_env_line("   "), None);
        assert_eq!(parse_env_line("# comment"), None);
        assert_eq!(parse_env_line("  # indented comment"), None);
        assert_eq!(parse_env_line("=novalue"), None);
        assert_eq!(parse_env_line("no equals sign"), None);
        assert_eq!(parse_env_line("1KEY=x"), None);
        assert_eq!(parse_env_line("MY-KEY=x"), None);
        assert_eq!(parse_env_line("TWO WORDS=x"), None);
    }

    #[test]
    fn parses_plain_assignments() {
        assert_eq!(
            parse_env_line("DATABASE_URL=postgres://localhost/zzz"),
            pair("DATABASE_URL", "postgres://localhost/zzz")
        );
        assert_eq!(parse_env_line("KEY = spaced "), pair("KEY", "spaced"));
        assert_eq!(parse_env_line("EMPTY="), pair("EMPTY", ""));
        assert_eq!(parse_env_line("_UNDER_1=x"), pair("_UNDER_1", "x"));
        // only the first `=` splits
        assert_eq!(parse_env_line("K=a=b"), pair("K", "a=b"));
    }

    #[test]
    fn strips_export_prefix() {
        assert_eq!(parse_env_line("export KEY=value"), pair("KEY", "value"));
        assert_eq!(parse_env_line("export\tKEY=value"), pair("KEY", "value"));
        assert_eq!(parse_env_line("  export   KEY=value"), pair("KEY", "value"));
        // a key that merely starts with `export` is a key
        assert_eq!(parse_env_line("EXPORTED=1"), pair("EXPORTED", "1"));
        assert_eq!(parse_env_line("exporter=1"), pair("exporter", "1"));
    }

    #[test]
    fn handles_quotes() {
        assert_eq!(
            parse_env_line("KEY = \"quoted value\""),
            pair("KEY", "quoted value")
        );
        assert_eq!(
            parse_env_line("KEY='single # not a comment'"),
            pair("KEY", "single # not a comment")
        );
        assert_eq!(
            parse_env_line(r#"KEY="a \"b\" c\\d\ne""#),
            pair("KEY", "a \"b\" c\\d\ne")
        );
        assert_eq!(
            parse_env_line("KEY=\"value\" # trailing comment"),
            pair("KEY", "value")
        );
        assert_eq!(parse_env_line("KEY='raw \\n'"), pair("KEY", "raw \\n"));
        // unterminated quotes keep the raw text
        assert_eq!(parse_env_line("KEY=\"open"), pair("KEY", "\"open"));
        assert_eq!(parse_env_line("KEY='open"), pair("KEY", "'open"));
    }

    #[test]
    fn unquoted_values_end_at_inline_comments() {
        assert_eq!(parse_env_line("KEY=value # comment"), pair("KEY", "value"));
        assert_eq!(parse_env_line("KEY=value\t# comment"), pair("KEY", "value"));
        // `#` without leading whitespace is part of the value
        assert_eq!(parse_env_line("KEY=a#b"), pair("KEY", "a#b"));
        assert_eq!(parse_env_line("KEY=#x"), pair("KEY", "#x"));
    }

    #[test]
    fn parse_env_keeps_file_order_and_reports_skipped_lines() {
        let parsed = parse_env("# header\nA=1\n\nexport B=\"two\"\nnot a line\nC='3'\n1BAD=x\n");
        assert_eq!(
            parsed,
            ParsedEnv {
                vars: vec![
                    ("A".to_owned(), "1".to_owned()),
                    ("B".to_owned(), "two".to_owned()),
                    ("C".to_owned(), "3".to_owned()),
                ],
                skipped_lines: vec![5, 7],
            }
        );
    }

    #[test]
    fn parse_env_ignores_a_leading_bom() {
        let parsed = parse_env("\u{feff}KEY=value\n");
        assert_eq!(parsed.vars, vec![("KEY".to_owned(), "value".to_owned())]);
        assert!(parsed.skipped_lines.is_empty());
    }

    #[test]
    fn values_are_literal() {
        assert_eq!(parse_env_line("A=${HOME}/x"), pair("A", "${HOME}/x"));
    }
}

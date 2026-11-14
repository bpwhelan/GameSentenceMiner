//! Pattern-based local log redaction (home paths, usernames, hostnames, secrets, IPs, emails).
use gsm_settings::Result;
use regex::{Regex, RegexBuilder};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::OnceLock;

#[derive(Clone, Debug, Default)]
pub struct LogRedactionContext {
    pub home_paths: Vec<String>,
    pub usernames: Vec<String>,
    pub hostnames: Vec<String>,
}

impl LogRedactionContext {
    pub fn from_system() -> Self {
        let mut home_paths = Vec::new();
        if let Some(dir) = gsm_settings::paths::home_dir() {
            home_paths.push(dir.to_string_lossy().into_owned());
        }
        for key in ["USERPROFILE", "HOME"] {
            if let Ok(val) = std::env::var(key) {
                if !val.trim().is_empty() {
                    home_paths.push(val);
                }
            }
        }

        let mut usernames = Vec::new();
        for key in ["USERNAME", "USER", "LOGNAME"] {
            if let Ok(val) = std::env::var(key) {
                if !val.trim().is_empty() {
                    usernames.push(val);
                }
            }
        }

        let mut hostnames = Vec::new();
        for key in ["COMPUTERNAME", "HOSTNAME"] {
            if let Ok(val) = std::env::var(key) {
                if !val.trim().is_empty() {
                    hostnames.push(val);
                }
            }
        }

        Self {
            home_paths,
            usernames,
            hostnames,
        }
    }
}

#[derive(Clone)]
pub struct LogRedactor {
    homes: Option<Regex>,
    users: Option<Regex>,
    hosts: Option<Regex>,
}

impl Default for LogRedactor {
    fn default() -> Self {
        Self::new(LogRedactionContext::from_system())
    }
}

struct StaticPatterns {
    win_home: Regex,
    unix_home: Regex,
    encoded_home_prefix: Regex,
    url_userinfo: Regex,
    http_header: Regex,
    private_field_prefix: Regex,
    query_secret: Regex,
    bearer_basic: Regex,
    token_literals: Regex,
    email: Regex,
    ipv6: Regex,
    mac: Regex,
    ipv4: Regex,
    drive_root: Regex,
}

fn static_patterns() -> &'static StaticPatterns {
    static PATTERNS: OnceLock<StaticPatterns> = OnceLock::new();
    PATTERNS.get_or_init(|| StaticPatterns {
        win_home: Regex::new(
            r#"(?i)\b[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n"'<>|]+"#,
        )
        .unwrap(),
        unix_home: Regex::new(r#"(?-u)/[A-Za-z0-9._-]*"#)
            .ok()
            .filter(|_| false)
            .unwrap_or_else(|| Regex::new(r#"/(?:home|Users)/[^/\\\r\n"'<>|]+"#).unwrap()),
        encoded_home_prefix: Regex::new(
            r#"(?i)(?:[a-z](?::|%3a)(?:%5c|%2f)+(?:Users|Documents%20and%20Settings)|%2f(?:home|Users))(?:%5c|%2f)+"#,
        )
        .unwrap(),
        url_userinfo: Regex::new(r#"(?i)(\b[a-z][a-z\d+.-]*://)[^\s/]+@"#).unwrap(),
        http_header: Regex::new(
            r#"(?i)(\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)[ \t]*:[ \t]*)[^\r\n]+"#,
        )
        .unwrap(),
        private_field_prefix: Regex::new(
            r#"(?i)['"]?(?:[A-Za-z0-9_.-]*(?:password|passwd|passphrase|api[ _-]?key|token|secret|cookie|user[ _-]?name|e[ _-]?mail|authorization|credential|client[_-]?id|session[_-]?id)|pwd|login|user)['"]?\s*[:=]\s*"#,
        )
        .unwrap(),
        query_secret: Regex::new(
            r#"(?i)([?&](?:key|sig|signature|code|auth|session|credential)\s*=)[^&\s#"'<>]+"#,
        )
        .unwrap(),
        bearer_basic: Regex::new(r#"(?i)\b(Bearer|Basic)\s+[a-z\d._~+/=-]+"#).unwrap(),
        token_literals: Regex::new(
            r#"(?i)\b(?:sk-[a-z\d_-]{12,}|AIza[a-z\d_-]{20,}|gh[pousr]_[a-z\d_]{20,}|github_pat_[a-z\d_]{20,}|eyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+)\b"#,
        )
        .unwrap(),
        email: Regex::new(
            r#"(?i)[a-z\d.!#$%&'*+/=?^_`{|}~-]+(?:@|%40)(?:[a-z\d-]+\.)+[a-z]{2,63}"#,
        )
        .unwrap(),
        ipv6: Regex::new(r#"(?i)(?:[a-f\d]*:){2,}[a-f\d.]*(?:%[A-Za-z0-9._-]+)?"#).unwrap(),
        mac: Regex::new(r#"(?i)\b(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}\b"#).unwrap(),
        ipv4: Regex::new(r#"\b(?:\d{1,3}\.){3}\d{1,3}\b"#).unwrap(),
        drive_root: Regex::new(r#"(?i)^[a-z]:[\\/]?$"#).unwrap(),
    })
}

fn is_uri_unreserved_or_mark(byte: u8) -> bool {
    matches!(
        byte,
        b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')'
    )
}

fn is_encode_uri_kept(byte: u8) -> bool {
    is_uri_unreserved_or_mark(byte)
        || matches!(
            byte,
            b';' | b'/' | b'?' | b':' | b'@' | b'&' | b'=' | b'+' | b'$' | b',' | b'#'
        )
}

fn percent_encode(input: &str, keep: impl Fn(u8) -> bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if keep(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

fn encoded_forms(value: &str) -> [String; 4] {
    let json_escaped = serde_json::to_string(value)
        .ok()
        .and_then(|s| s.get(1..s.len().saturating_sub(1)).map(ToOwned::to_owned))
        .unwrap_or_else(|| value.to_owned());
    [
        value.to_owned(),
        json_escaped,
        percent_encode(value, is_encode_uri_kept),
        percent_encode(value, is_uri_unreserved_or_mark),
    ]
}

fn compile_literal_alternation(values: impl Iterator<Item = String>) -> Option<Regex> {
    let unique: BTreeSet<String> = values.filter(|v| !v.trim().is_empty()).collect();
    if unique.is_empty() {
        return None;
    }
    let mut sorted: Vec<String> = unique.into_iter().collect();
    sorted.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    let pattern = sorted
        .into_iter()
        .map(|s| regex::escape(&s))
        .collect::<Vec<_>>()
        .join("|");
    RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .ok()
}

fn is_boundary_alnum(ch: char) -> bool {
    ch.is_alphanumeric()
}

fn is_word_char(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

fn replace_with_alnum_boundary(text: &str, re: &Regex, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(m) = re.find_at(text, cursor) else {
            out.push_str(&text[cursor..]);
            break;
        };
        let prev_ok = text[..m.start()]
            .chars()
            .next_back()
            .is_none_or(|c| !is_boundary_alnum(c));
        let next_ok = text[m.end()..]
            .chars()
            .next()
            .is_none_or(|c| !is_boundary_alnum(c));

        if prev_ok && next_ok {
            out.push_str(&text[cursor..m.start()]);
            out.push_str(replacement);
            if m.end() == cursor {
                if let Some(ch) = text[cursor..].chars().next() {
                    out.push(ch);
                    cursor += ch.len_utf8();
                } else {
                    break;
                }
            } else {
                cursor = m.end();
            }
        } else {
            let advance = text[m.start()..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
            let next_pos = (m.start() + advance).min(text.len());
            out.push_str(&text[cursor..next_pos]);
            cursor = next_pos;
        }
    }
    out
}

fn replace_encoded_homes(text: &str, prefix_re: &Regex) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(m) = prefix_re.find_at(text, cursor) {
        let bytes = text.as_bytes();
        let mut end = m.end();
        while end < bytes.len() {
            let b = bytes[end];
            if b.is_ascii_whitespace() || matches!(b, b'"' | b'\'' | b'<' | b'>') {
                break;
            }
            if b == b'%' && end + 2 < bytes.len() {
                let code = &bytes[end + 1..end + 3];
                if code.eq_ignore_ascii_case(b"2f") || code.eq_ignore_ascii_case(b"5c") {
                    break;
                }
            }
            end += 1;
        }
        if end > m.end() {
            out.push_str(&text[cursor..m.start()]);
            out.push_str("[HOME]");
            cursor = end;
        } else {
            out.push_str(&text[cursor..m.end()]);
            cursor = m.end();
        }
    }
    out.push_str(&text[cursor..]);
    out
}

fn scan_quoted_value_end(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut idx = start + 1;
    let mut escaped = false;
    while idx < bytes.len() {
        let b = bytes[idx];
        if escaped {
            escaped = false;
        } else if b == b'\\' {
            escaped = true;
        } else if b == quote {
            return idx + 1;
        }
        idx += 1;
    }
    bytes.len()
}

fn redact_private_fields(text: &str, prefix_re: &Regex) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let bytes = text.as_bytes();
    while cursor < text.len() {
        let Some(m) = prefix_re.find_at(text, cursor) else {
            out.push_str(&text[cursor..]);
            break;
        };
        let prev_ok = text[..m.start()]
            .chars()
            .next_back()
            .is_none_or(|c| !is_word_char(c));
        let val_start = m.end();
        if !prev_ok || val_start >= bytes.len() {
            let advance = text[m.start()..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
            let next_pos = (m.start() + advance).min(text.len());
            out.push_str(&text[cursor..next_pos]);
            cursor = next_pos;
            continue;
        }

        let first = bytes[val_start];
        if first == b'"' || first == b'\'' {
            let val_end = scan_quoted_value_end(bytes, val_start, first);
            out.push_str(&text[cursor..val_start]);
            out.push(first as char);
            out.push_str("[REDACTED]");
            out.push(first as char);
            cursor = val_end;
        } else {
            let mut val_end = val_start;
            for (offset, ch) in text[val_start..].char_indices() {
                if ch.is_whitespace() || matches!(ch, ',' | ';' | '&' | '}' | ']' | ')') {
                    val_end = val_start + offset;
                    break;
                }
                val_end = text.len();
            }
            if val_end == val_start {
                let advance = text[m.start()..]
                    .chars()
                    .next()
                    .map_or(1, char::len_utf8);
                let next_pos = (m.start() + advance).min(text.len());
                out.push_str(&text[cursor..next_pos]);
                cursor = next_pos;
            } else {
                out.push_str(&text[cursor..val_start]);
                out.push_str("[REDACTED]");
                cursor = val_end;
            }
        }
    }
    out
}

fn redact_ipv6(text: &str, ipv6_re: &Regex) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(m) = ipv6_re.find_at(text, cursor) else {
            out.push_str(&text[cursor..]);
            break;
        };
        let prev_ok = text[..m.start()]
            .chars()
            .next_back()
            .is_none_or(|c| c != ':' && !is_word_char(c));
        let candidate = m.as_str();
        let addr_part = candidate.split('%').next().unwrap_or(candidate);
        let parsed = addr_part.parse::<Ipv6Addr>();
        let keep = !prev_ok
            || match parsed {
                Err(_) => true,
                Ok(ip) => {
                    ip.is_loopback()
                        || ip.is_unspecified()
                        || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
                }
            };
        if keep {
            out.push_str(&text[cursor..m.end()]);
        } else {
            out.push_str(&text[cursor..m.start()]);
            out.push_str("[IP]");
        }
        cursor = m.end();
    }
    out
}

fn redact_ipv4(text: &str, ipv4_re: &Regex) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for m in ipv4_re.find_iter(text) {
        let replace = match m.as_str().parse::<IpAddr>() {
            Ok(IpAddr::V4(v4)) => !v4.is_loopback() && !v4.is_unspecified(),
            _ => false,
        };
        out.push_str(&text[cursor..m.start()]);
        if replace {
            out.push_str("[IP]");
        } else {
            out.push_str(m.as_str());
        }
        cursor = m.end();
    }
    out.push_str(&text[cursor..]);
    out
}

fn redact_json_escaped_strings(text: &str, depth: u8, redactor: &LogRedactor) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut idx = 0usize;

    while idx < bytes.len() {
        if bytes[idx] != b'"' {
            idx += 1;
            continue;
        }
        let open = idx;
        let mut scan = open + 1;
        let mut has_backslash = false;
        let mut escaped = false;
        let mut close = None;
        while scan < bytes.len() {
            let b = bytes[scan];
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                has_backslash = true;
                escaped = true;
            } else if b == b'"' {
                close = Some(scan);
                break;
            }
            scan += 1;
        }

        let Some(end) = close else {
            break;
        };
        if has_backslash {
            let literal = &text[open..=end];
            if let Ok(decoded) = serde_json::from_str::<String>(literal) {
                out.push_str(&text[cursor..open]);
                if depth >= 4 {
                    out.push_str("\"[REDACTED]\"");
                } else {
                    let sanitized = redactor.redact_with_depth(&decoded, depth + 1);
                    if sanitized == decoded {
                        out.push_str(literal);
                    } else if let Ok(reencoded) = serde_json::to_string(&sanitized) {
                        out.push_str(&reencoded);
                    } else {
                        out.push_str(literal);
                    }
                }
                cursor = end + 1;
            }
        }
        idx = end + 1;
    }

    out.push_str(&text[cursor..]);
    out
}

fn apply_regex_in_place(buf: &mut String, re: &Regex, rep: &str) {
    if let std::borrow::Cow::Owned(next) = re.replace_all(buf, rep) {
        *buf = next;
    }
}

impl LogRedactor {
    pub fn new(context: LogRedactionContext) -> Self {
        let p = static_patterns();
        let homes = compile_literal_alternation(
            context
                .home_paths
                .iter()
                .filter(|h| h.len() > 1 && !p.drive_root.is_match(h))
                .flat_map(|home| {
                    let fwd = home.replace('\\', "/");
                    let back = home.replace('/', "\\");
                    [home.clone(), fwd, back].into_iter().flat_map(|form| encoded_forms(&form))
                }),
        );
        let users = compile_literal_alternation(
            context
                .usernames
                .iter()
                .flat_map(|u| encoded_forms(u)),
        );
        let hosts = compile_literal_alternation(
            context
                .hostnames
                .iter()
                .flat_map(|h| encoded_forms(h)),
        );

        Self {
            homes,
            users,
            hosts,
        }
    }

    pub fn redact(&self, text: &str) -> String {
        self.redact_with_depth(text, 0)
    }

    fn redact_with_depth(&self, text: &str, depth: u8) -> String {
        let p = static_patterns();
        let mut result = if text.contains('\\') {
            redact_json_escaped_strings(text, depth, self)
        } else {
            text.to_owned()
        };

        if let Some(homes) = &self.homes {
            apply_regex_in_place(&mut result, homes, "[HOME]");
        }

        apply_regex_in_place(&mut result, &p.win_home, "[HOME]");
        apply_regex_in_place(&mut result, &p.unix_home, "[HOME]");

        if (result.contains('%') || result.contains(':'))
            && p.encoded_home_prefix.is_match(&result)
        {
            result = replace_encoded_homes(&result, &p.encoded_home_prefix);
        }
        if result.contains("://") {
            apply_regex_in_place(&mut result, &p.url_userinfo, "${1}[REDACTED]@");
        }
        if result.contains(':') || result.contains('=') {
            apply_regex_in_place(&mut result, &p.http_header, "${1}[REDACTED]");
            if p.private_field_prefix.is_match(&result) {
                result = redact_private_fields(&result, &p.private_field_prefix);
            }
        }
        if result.contains('=') {
            apply_regex_in_place(&mut result, &p.query_secret, "${1}[REDACTED]");
        }
        apply_regex_in_place(&mut result, &p.bearer_basic, "${1} [REDACTED]");
        apply_regex_in_place(&mut result, &p.token_literals, "[REDACTED]");
        if result.contains('@') || result.contains("%40") {
            apply_regex_in_place(&mut result, &p.email, "[EMAIL]");
        }
        if result.contains(':') {
            if p.ipv6.is_match(&result) {
                result = redact_ipv6(&result, &p.ipv6);
            }
            apply_regex_in_place(&mut result, &p.mac, "[MAC]");
        }
        if result.contains('.') && p.ipv4.is_match(&result) {
            result = redact_ipv4(&result, &p.ipv4);
        }
        if let Some(hosts) = &self.hosts {
            if hosts.is_match(&result) {
                result = replace_with_alnum_boundary(&result, hosts, "[HOST]");
            }
        }
        if let Some(users) = &self.users {
            if users.is_match(&result) {
                result = replace_with_alnum_boundary(&result, users, "[USER]");
            }
        }

        result
    }

    pub fn redact_segment(&self, segment: &str) -> String {
        let mut clean = String::new();
        for ch in self.redact(segment).chars() {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (ch as u32) < 0x20
            {
                clean.push('_');
            } else {
                clean.push(ch);
            }
        }
        if clean.is_empty() || clean == "." || clean == ".." {
            "_".into()
        } else {
            clean
        }
    }
}

pub fn create_log_redactor(context: LogRedactionContext) -> Result<LogRedactor> {
    Ok(LogRedactor::new(context))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn redacts_homes_credentials_ips_emails_and_preserves_loopback() {
        let redactor = LogRedactor::new(LogRedactionContext {
            home_paths: vec![r"C:\Users\Alice".into(), "/home/alice".into()],
            usernames: vec!["alice".into()],
            hostnames: vec!["ALICE-PC".into()],
        });

        let sample = concat!(
            "User alice on ALICE-PC opened C:\\Users\\Alice\\GSM\\gsm.log alice_note malice alice123\n",
            "api_key=\"sk-1234567890abcdef\" token='abc 123' https://user:secret@example.com/hook?code=xyz\n",
            "Authorization: Bearer topsecret.token.value\n",
            "peer=192.168.1.42 local=127.0.0.1 zero=0.0.0.0 v6=2001:db8::1 loop=::1 v6map=::ffff:127.0.0.1\n",
            "contact=alice.dev@example.org mac=aa:bb:cc:dd:ee:ff\n",
            "encoded=C%3A%5CUsers%5CAlice%5CAppData\n",
            "nested={\"msg\":\"C:\\\\Users\\\\Alice\\\\secret api_key=\\\"12345\\\"\"}\n",
        );

        let redacted = redactor.redact(sample);
        assert!(!redacted.contains("Alice"));
        assert!(!redacted.contains("ALICE-PC"));
        assert!(!redacted.contains("sk-1234567890abcdef"));
        assert!(!redacted.contains("topsecret"));
        assert!(!redacted.contains("192.168.1.42"));
        assert!(!redacted.contains("2001:db8::1"));
        assert!(!redacted.contains("alice.dev@example.org"));
        assert!(!redacted.contains("aa:bb:cc:dd:ee:ff"));
        assert!(redacted.contains("[USER] on [HOST]"));
        assert!(redacted.contains("[USER]_note malice alice123"));
        assert!(redacted.contains("127.0.0.1"));
        assert!(redacted.contains("0.0.0.0"));
        assert!(redacted.contains("::1"));
        assert!(redacted.contains("::ffff:127.0.0.1"));
        assert!(redacted.contains("[EMAIL]"));
        assert!(redacted.contains("[MAC]"));
        assert!(redacted.contains("encoded=[HOME]"));
        assert!(redacted.contains("[HOME]"));
        assert!(!redacted.contains("12345"));
    }

    #[test]
    #[ignore = "Release benchmark: cargo test --release --manifest-path native/gsm-packages/Cargo.toml bench_log_redaction_throughput -- --ignored --nocapture"]
    fn bench_log_redaction_throughput() {
        let redactor = LogRedactor::new(LogRedactionContext {
            home_paths: vec![r"C:\Users\PlayerOne".into()],
            usernames: vec!["PlayerOne".into()],
            hostnames: vec!["GAMING-RIG".into()],
        });
        let chunk = concat!(
            "2026-11-13 02:15:00 | INFO | gsm.obs | Captured frame from C:\\Users\\PlayerOne\\Videos\\GSM\\shot.png\n",
            "2026-11-13 02:15:01 | DEBUG | gsm.http | GET http://127.0.0.1:7275/api/status -> 200 OK host=GAMING-RIG\n",
            "2026-11-13 02:15:02 | INFO | gsm.anki | Updated note with token=sk-abcdefghijklmno on peer=203.0.113.5\n",
            "2026-11-13 02:15:03 | INFO | gsm.text | Normal Japanese line without secrets 今日はいい天気ですね。\n",
        );
        let input = chunk.repeat((1024 * 1024 / chunk.len()) + 1);
        let started = Instant::now();
        let out = redactor.redact(&input);
        let elapsed = started.elapsed();
        let mb = input.len() as f64 / (1024.0 * 1024.0);
        let mb_per_sec = mb / elapsed.as_secs_f64();
        println!(
            "bench_log_redaction_throughput: input={:.2} MiB output={:.2} MiB elapsed={:.2?} ({:.1} MiB/s)",
            mb,
            out.len() as f64 / (1024.0 * 1024.0),
            elapsed,
            mb_per_sec
        );
        assert!(out.len() > 0);
    }
}

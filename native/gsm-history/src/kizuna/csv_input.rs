use super::InvalidFile;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{self, BufRead, Read},
};

pub(super) struct Session {
    pub name: String,
    pub vndb: String,
    pub timestamp: f64,
    pub date: String,
    pub seconds: f64,
    pub chars: i64,
    pub lines: i64,
    pub id: String,
}
impl Session {
    pub fn key(&self) -> &str {
        if self.vndb.is_empty() {
            &self.name
        } else {
            &self.vndb
        }
    }
}

// The CSV crate accepts an unterminated quote at EOF. Kizuna uses strict
// CSV, so verify quote boundaries before the parser consumes each chunk.
#[derive(Clone, Copy, PartialEq)]
enum State {
    Start,
    Plain,
    Quoted,
    Closing,
}
struct Strict<R> {
    inner: R,
    state: State,
}
impl<R: Read> Read for Strict<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = self.inner.read(buf)?;
        if n == 0 && self.state == State::Quoted {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected end of data",
            ));
        }
        use State::*;
        for &byte in &buf[..n] {
            self.state = match (self.state, byte) {
                (Start | Closing, b'"') => Quoted,
                (Quoted, b'"') => Closing,
                (Quoted, _) => Quoted,
                (_, b',' | b'\r' | b'\n') => Start,
                (Closing, _) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "',' expected after '\"'",
                    ))
                }
                _ => Plain,
            };
        }
        Ok(n)
    }
}

fn csv_error(e: csv::Error) -> InvalidFile {
    match e.kind() {
        csv::ErrorKind::Utf8 { .. } => {
            InvalidFile("Please save the Kizuna CSV with UTF-8 encoding".into())
        }
        _ => InvalidFile(e.to_string()),
    }
}

const COLUMNS: [&str; 6] = [
    "vndb_id",
    "name",
    "date",
    "duration_seconds",
    "chars",
    "lines",
];
pub(super) struct Sessions<R: BufRead> {
    reader: csv::Reader<Strict<R>>,
    record: csv::StringRecord,
    indices: [usize; 6],
    width: usize,
    row: usize,
}
impl<R: BufRead> Sessions<R> {
    pub fn new(mut file: R) -> crate::Result<Self> {
        if file.fill_buf()?.starts_with(&[0xef, 0xbb, 0xbf]) {
            file.consume(3);
        }
        let mut reader = csv::ReaderBuilder::new()
            .flexible(true)
            .from_reader(Strict {
                inner: file,
                state: State::Start,
            });
        let headers = reader.headers().map_err(csv_error)?;
        let width = headers.len();
        let names = headers.iter().map(str::trim).collect::<BTreeSet<_>>();
        let missing = COLUMNS
            .into_iter()
            .filter(|key| !names.contains(key))
            .collect::<BTreeSet<_>>();
        if !missing.is_empty() {
            return Err(InvalidFile(format!(
                "Invalid Kizuna CSV. Missing required columns: {}",
                missing.into_iter().collect::<Vec<_>>().join(", ")
            ))
            .into());
        }
        if names.len() != width {
            return Err(InvalidFile("Invalid Kizuna CSV: duplicate column names".into()).into());
        }
        let indices = COLUMNS.map(|key| {
            headers
                .iter()
                .position(|h| h.trim() == key)
                .expect("checked column")
        });
        Ok(Self {
            reader,
            record: csv::StringRecord::new(),
            indices,
            width,
            row: 1,
        })
    }
    pub fn next(&mut self) -> crate::Result<Option<Session>> {
        while self
            .reader
            .read_record(&mut self.record)
            .map_err(csv_error)?
        {
            self.row += 1;
            if self.record.len() > self.width
                || self.indices.iter().any(|&i| i >= self.record.len())
            {
                return Err(
                    InvalidFile(format!("Row {}: incorrect number of columns", self.row)).into(),
                );
            }
            let fields = self.indices.map(|i| self.record[i].trim());
            let row =
                parse(fields).map_err(|msg| InvalidFile(format!("Row {}: {msg}", self.row)))?;
            if row.is_some() {
                return Ok(row);
            }
        }
        Ok(None)
    }
}

fn session_time(raw: &str) -> Option<(f64, String)> {
    let naive = || {
        for fmt in [
            "%Y-%m-%dT%H:%M:%S%.f",
            "%Y-%m-%d %H:%M:%S%.f",
            "%Y%m%dT%H%M%S%.f",
            "%Y-%m-%dT%H:%M",
            "%Y-%m-%d %H:%M",
        ] {
            if let Ok(value) = NaiveDateTime::parse_from_str(raw, fmt) {
                return Some(value);
            }
        }
        for fmt in ["%Y-%m-%d", "%Y%m%d", "%G-W%V-%u"] {
            if let Ok(day) = NaiveDate::parse_from_str(raw, fmt) {
                return day.and_hms_opt(0, 0, 0);
            }
        }
        None
    };
    let aware = DateTime::parse_from_rfc3339(raw).ok().or_else(|| {
        [
            "%Y-%m-%d %H:%M:%S%.f%#z",
            "%Y-%m-%dT%H:%M:%S%.f%#z",
            "%Y%m%dT%H%M%S%.f%#z",
        ]
        .iter()
        .find_map(|fmt| DateTime::parse_from_str(raw, fmt).ok())
    });
    let micros = if let Some(t) = aware {
        t.timestamp_micros()
    } else {
        (gsm_db::local_timestamp(naive()?).ok()? * 1e6).round() as i64
    };
    let day = DateTime::from_timestamp_micros(micros)?
        .with_timezone(&Local)
        .date_naive();
    Some((micros as f64 / 1e6, day.to_string()))
}

// Older GSM releases fingerprinted Python json.dumps output, including its
// spaces, exponent padding and decimal point for integral floats.
fn python_float(value: f64) -> String {
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0.0"
        } else {
            "0.0"
        }
        .into();
    }
    let raw = serde_json::to_string(&value.abs()).expect("finite number");
    let (mantissa, shift) = raw
        .split_once(['e', 'E'])
        .map_or((raw.as_str(), 0), |(v, e)| (v, e.parse::<i32>().unwrap()));
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let digits = mantissa.replace('.', "");
    let trimmed = digits.trim_start_matches('0');
    let exponent = shift + point - 1 - (digits.len() - trimmed.len()) as i32;
    let significant = trimmed.trim_end_matches('0');
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if !(-4..16).contains(&exponent) {
        let (first, rest) = significant.split_at(1);
        let dot = if rest.is_empty() { "" } else { "." };
        return format!("{sign}{first}{dot}{rest}e{exponent:+03}");
    }
    let point = exponent + 1;
    if point <= 0 {
        format!("{sign}0.{}{significant}", "0".repeat((-point) as usize))
    } else if point as usize >= significant.len() {
        format!(
            "{sign}{significant}{}.0",
            "0".repeat(point as usize - significant.len())
        )
    } else {
        let (whole, fraction) = significant.split_at(point as usize);
        format!("{sign}{whole}.{fraction}")
    }
}

fn parse(
    [vndb, name, raw_time, duration, chars, lines]: [&str; 6],
) -> Result<Option<Session>, String> {
    if name.is_empty() {
        return Err("game name is required".into());
    }
    let vndb = vndb.to_ascii_lowercase();
    if !vndb.is_empty()
        && !vndb.strip_prefix('v').is_some_and(|id| {
            matches!(id.as_bytes().first(), Some(b'1'..=b'9'))
                && id.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err("vndb_id must be a VNDB ID such as v58562, or empty".into());
    }
    let (timestamp, date) =
        session_time(raw_time).ok_or_else(|| format!("Invalid isoformat string: '{raw_time}'"))?;
    let seconds = duration
        .parse::<f64>()
        .map_err(|_| format!("could not convert string to float: '{duration}'"))?;
    let integer = |s: &str| {
        s.parse::<i64>().map_err(|e| match e.kind() {
            std::num::IntErrorKind::PosOverflow => "chars and lines are too large".into(),
            std::num::IntErrorKind::NegOverflow => {
                "duration_seconds, chars and lines must be finite, non-negative numbers".into()
            }
            _ => format!("invalid literal for int() with base 10: '{s}'"),
        })
    };
    let chars = integer(chars)?;
    let lines = integer(lines)?;
    if !seconds.is_finite() || seconds < 0. || chars < 0 || lines < 0 {
        return Err(
            "duration_seconds, chars and lines must be finite, non-negative numbers".into(),
        );
    }
    if seconds == 0. && chars == 0 && lines == 0 {
        return Ok(None);
    }
    let key = if vndb.is_empty() { name } else { &vndb };
    let identity = format!(
        "[{}, {}, {}, {chars}, {lines}]",
        serde_json::to_string(key).unwrap(),
        python_float(timestamp),
        python_float(seconds)
    );
    let id = format!("{:x}", Sha256::digest(identity.as_bytes()));
    Ok(Some(Session {
        name: name.into(),
        vndb,
        date,
        timestamp,
        seconds,
        chars,
        lines,
        id,
    }))
}

//! Decode the structured-clone types used by the two dictionary extensions.
//! Keep V8 object IDs while parsing, so a typed view refers to the right buffer.
use crate::storage::{byte, integer, sized, string, take, utf16};
use anyhow::{bail, ensure, Context, Result};
use num_bigint::BigUint;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    rc::Rc,
};

pub(crate) fn binary(dir: &Path, mut source: impl Read, kind: &str) -> Result<Value> {
    let mut file = tempfile::NamedTempFile::new_in(dir.join("blobs"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = source.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
        file.write_all(&buffer[..n])?;
    }
    let name = format!("blobs/{:x}.bin", digest.finalize());
    if let Err(e) = file.persist_noclobber(dir.join(&name)) {
        if e.error.kind() != io::ErrorKind::AlreadyExists {
            return Err(e.error.into());
        }
    }
    Ok(json!({"$gsm":"binary","kind":kind,"file":name}))
}
pub(crate) fn binary_bytes(dir: &Path, data: &[u8], kind: &str) -> Result<Value> {
    let name = format!("blobs/{:x}.bin", Sha256::digest(data));
    let target = dir.join(&name);
    if !target.exists() {
        let mut file = tempfile::NamedTempFile::new_in(dir.join("blobs"))?;
        file.write_all(data)?;
        if let Err(e) = file.persist_noclobber(&target) {
            if e.error.kind() != io::ErrorKind::AlreadyExists {
                return Err(e.error.into());
            }
        }
    }
    Ok(json!({"$gsm":"binary","kind":kind,"file":name}))
}
fn number(n: f64) -> Value {
    if n.is_finite() {
        json!(n)
    } else {
        json!({"$gsm":"number","value":if n.is_nan(){"NaN"}else if n.is_sign_negative(){"-Infinity"}else{"Infinity"}})
    }
}
pub(crate) fn date(ms: f64) -> Result<Value> {
    ensure!(ms.is_finite() && ms.abs() <= 8.64e15, "Invalid saved date");
    Ok(json!({"$gsm":"date","value":ms}))
}
fn double(input: &mut &[u8]) -> Result<f64> {
    Ok(f64::from_le_bytes(take(input, 8)?.try_into()?))
}

fn tagged_array(kind: &str, values: Vec<Value>) -> Value {
    // Building a json! object from a Vec<Value> would serialize and copy the
    // entire subtree again at every nesting level.
    Value::Object(
        [
            ("$gsm".into(), kind.into()),
            ("value".into(), Value::Array(values)),
        ]
        .into_iter()
        .collect(),
    )
}

pub(crate) fn key(input: &mut &[u8], dir: &Path, depth: u8) -> Result<Value> {
    ensure!(depth < 100, "Dictionary key nesting limit");
    Ok(match byte(input)? {
        0 => Value::Null,
        1 => string(input)?.into(),
        2 => date(double(input)?)?,
        3 => number(double(input)?),
        4 => {
            let n = integer(input)?;
            ensure!(n <= input.len() as u64, "Truncated array key");
            let mut a = Vec::new();
            for _ in 0..n {
                a.push(key(input, dir, depth + 1)?)
            }
            tagged_array("array", a)
        }
        6 => binary_bytes(dir, sized(input)?, "ArrayBuffer")?,
        _ => bail!("Unsupported dictionary key type"),
    })
}

pub(crate) struct External {
    pub path: PathBuf,
    pub mime: String,
    pub size: u64,
}
type Resolver<'a> = dyn Fn(u64) -> Result<External> + 'a;
enum Node<'a> {
    Scalar(Value),
    Array(Vec<Rc<Self>>),
    Object(Vec<(String, Rc<Self>)>),
    Bytes(&'a [u8], &'static str),
    Blob(External),
}
type Item<'a> = Rc<Node<'a>>;
impl Node<'_> {
    fn json(&self, dir: &Path, budget: &mut usize) -> Result<Value> {
        *budget = budget
            .checked_sub(1)
            .context("Dictionary value too large")?;
        Ok(match self {
            Self::Scalar(v) => v.clone(),
            Self::Array(a) => tagged_array(
                "array",
                a.iter()
                    .map(|v| v.json(dir, budget))
                    .collect::<Result<_>>()?,
            ),
            Self::Object(o) => {
                let mut pairs = Vec::with_capacity(o.len());
                for (k, v) in o {
                    pairs.push(Value::Array(vec![k.clone().into(), v.json(dir, budget)?]));
                }
                tagged_array("object", pairs)
            }
            Self::Bytes(data, kind) => binary_bytes(dir, *data, kind)?,
            Self::Blob(blob) => {
                let file = fs::File::open(&blob.path)?;
                ensure!(
                    file.metadata()?.len() == blob.size,
                    "Dictionary media size changed"
                );
                let mut v = binary(dir, file, "Blob")?;
                v["mime"] = blob.mime.clone().into();
                v
            }
        })
    }
}
struct Decoder<'a, 'f> {
    input: &'a [u8],
    version: u64,
    objects: Vec<Option<Item<'a>>>,
    resolve: &'f Resolver<'f>,
}
impl<'a> Decoder<'a, '_> {
    fn peek(&mut self) -> Result<u8> {
        while self.input.first() == Some(&0) {
            self.input = &self.input[1..]
        }
        self.input.first().copied().context("Truncated V8 value")
    }
    fn slot(&mut self) -> usize {
        let id = self.objects.len();
        self.objects.push(None);
        id
    }
    fn property(&mut self, depth: u8) -> Result<String> {
        match self.read(depth)?.as_ref() {
            Node::Scalar(Value::String(k)) => Ok(k.clone()),
            Node::Scalar(Value::Number(k)) => Ok(k.to_string()),
            _ => bail!("Unsupported dictionary property name"),
        }
    }
    fn read(&mut self, depth: u8) -> Result<Item<'a>> {
        ensure!(depth < 100, "Dictionary value nesting limit");
        let tag = self.peek()?;
        byte(&mut self.input)?;
        let mut slot = None;
        let node = match tag {
            b'?' => {
                integer(&mut self.input)?;
                return self.read(depth + 1);
            }
            b'_' | b'-' => Node::Scalar(json!({"$gsm":"undefined"})),
            b'0' => Node::Scalar(Value::Null),
            b'T' | b'F' => Node::Scalar((tag == b'T').into()),
            b'I' => {
                let n = u32::try_from(integer(&mut self.input)?)?;
                Node::Scalar((((n >> 1) as i32) ^ -((n & 1) as i32)).into())
            }
            b'U' => Node::Scalar(integer(&mut self.input)?.into()),
            b'N' => Node::Scalar(number(double(&mut self.input)?)),
            b'Z' => {
                let flags = integer(&mut self.input)?;
                let n =
                    BigUint::from_bytes_le(take(&mut self.input, usize::try_from(flags >> 1)?)?);
                Node::Scalar(
                    json!({"$gsm":"bigint","value":format!("{}{n}",if flags&1!=0{"-"}else{""})}),
                )
            }
            b'S' | b'"' | b'c' => {
                let s = sized(&mut self.input)?;
                Node::Scalar(
                    match tag {
                        b'S' => std::str::from_utf8(s)?.to_owned(),
                        b'c' => utf16(s, false)?,
                        _ => s.iter().copied().map(char::from).collect(),
                    }
                    .into(),
                )
            }
            b'^' => {
                let id = usize::try_from(integer(&mut self.input)?)?;
                let item = self
                    .objects
                    .get(id)
                    .and_then(Option::as_ref)
                    .context("Invalid or cyclic dictionary value reference")?
                    .clone();
                return self.view(item);
            }
            b'D' => {
                slot = Some(self.slot());
                Node::Scalar(date(double(&mut self.input)?)?)
            }
            b'B' => {
                slot = Some(self.slot());
                Node::Bytes(sized(&mut self.input)?, "ArrayBuffer")
            }
            b'\\' => {
                slot = Some(self.slot());
                ensure!(
                    matches!(byte(&mut self.input)?, b'i' | b'e'),
                    "Unsupported dictionary host object"
                );
                Node::Blob((self.resolve)(integer(&mut self.input)?)?)
            }
            b'o' => {
                slot = Some(self.slot());
                let mut pairs = Vec::new();
                while self.peek()? != b'{' {
                    let k = self.property(depth + 1)?;
                    pairs.push((k, self.read(depth + 1)?))
                }
                byte(&mut self.input)?;
                ensure!(
                    integer(&mut self.input)? == pairs.len() as u64,
                    "Dictionary property count mismatch"
                );
                Node::Object(pairs)
            }
            b'a' | b'A' => {
                slot = Some(self.slot());
                let n = usize::try_from(integer(&mut self.input)?)?;
                ensure!(n <= 2_000_000, "Dictionary array too large");
                let mut values = Vec::new();
                let end = if tag == b'A' { b'$' } else { b'@' };
                if tag == b'A' {
                    ensure!(n <= self.input.len(), "Truncated dictionary array");
                    for _ in 0..n {
                        values.push(self.read(depth + 1)?)
                    }
                } else {
                    values.resize(n, Rc::new(Node::Scalar(Value::Null)))
                }
                let mut props = 0;
                while self.peek()? != end {
                    let k: usize = self.property(depth + 1)?.parse()?;
                    *values.get_mut(k).context("Invalid array index")? = self.read(depth + 1)?;
                    props += 1
                }
                byte(&mut self.input)?;
                ensure!(
                    integer(&mut self.input)? == props && integer(&mut self.input)? == n as u64,
                    "Dictionary array length mismatch"
                );
                Node::Array(values)
            }
            _ => bail!("Unsupported dictionary V8 tag {tag:#x}"),
        };
        let item = Rc::new(node);
        if let Some(id) = slot {
            self.objects[id] = Some(item.clone())
        }
        self.view(item)
    }
    fn view(&mut self, item: Item<'a>) -> Result<Item<'a>> {
        let Node::Bytes(buffer, "ArrayBuffer") = item.as_ref() else {
            return Ok(item);
        };
        if self.input.first() != Some(&b'V') {
            return Ok(item);
        }
        byte(&mut self.input)?;
        let kind = match u8::try_from(integer(&mut self.input)?)? {
            b'b' => "Int8Array",
            b'B' => "Uint8Array",
            b'C' => "Uint8ClampedArray",
            b'w' => "Int16Array",
            b'W' => "Uint16Array",
            b'd' => "Int32Array",
            b'D' => "Uint32Array",
            b'f' => "Float32Array",
            b'F' => "Float64Array",
            b'q' => "BigInt64Array",
            b'Q' => "BigUint64Array",
            b'?' => "DataView",
            _ => bail!("Unknown typed array"),
        };
        let start = usize::try_from(integer(&mut self.input)?)?;
        let len = usize::try_from(integer(&mut self.input)?)?;
        if self.version >= 14 {
            integer(&mut self.input)?;
        }
        let slice = buffer
            .get(start..)
            .and_then(|s| s.get(..len))
            .context("Invalid typed array slice")?;
        let view = Rc::new(Node::Bytes(slice, kind));
        self.objects.push(Some(view.clone()));
        Ok(view)
    }
}

pub(crate) fn decode(
    mut input: &[u8],
    dir: &Path,
    resolve: &Resolver<'_>,
    depth: u8,
) -> Result<Value> {
    ensure!(depth < 8 && byte(&mut input)? == 255, "Invalid Blink value");
    let version = integer(&mut input)?;
    if version == 17 {
        let expanded = match byte(&mut input)? {
            1 => {
                let size = integer(&mut input)?;
                let blob = resolve(integer(&mut input)?)?;
                ensure!(
                    size == blob.size
                        && size <= 512 * 1024 * 1024
                        && fs::metadata(&blob.path)?.len() == size,
                    "Invalid external dictionary value"
                );
                fs::read(blob.path)?
            }
            2 => {
                ensure!(
                    snap::raw::decompress_len(input)? <= 512 * 1024 * 1024,
                    "Compressed dictionary value too large"
                );
                snap::raw::Decoder::new().decompress_vec(input)?
            }
            _ => bail!("Unknown Blink value wrapper"),
        };
        return decode(&expanded, dir, resolve, depth + 1);
    }
    if version >= 21 {
        let trailer = take(&mut input, 13)?;
        ensure!(trailer[0] == 0xfe, "Invalid Blink trailer")
    }
    ensure!(byte(&mut input)? == 255, "Missing V8 value header");
    let version = integer(&mut input)?;
    Decoder {
        input,
        version,
        objects: Vec::new(),
        resolve,
    }
    .read(0)?
    .json(dir, &mut 4_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_structured_clone_preserves_transfer_format_and_budget() {
        let scalar = Rc::new(Node::Scalar(Value::from(42)));
        let array = Rc::new(Node::Array(vec![scalar.clone(), scalar]));
        let object = Node::Object(vec![("items".into(), array)]);
        let dir = Path::new(".");

        assert_eq!(
            object.json(dir, &mut 4).unwrap(),
            json!({"$gsm":"object","value":[["items",{"$gsm":"array","value":[42,42]}]]})
        );
        assert!(object.json(dir, &mut 3).is_err());
    }
}

//! A private socket to the optional CPU-only OneOCR runtime. One worker holds
//! the models across scans and exits when GSM closes the socket or releases it.
use super::*;
use crate::pipeline::TextBox;
use anyhow::{Context, ensure};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::{Child, Command, Stdio},
};

const WORKER: &str = include_str!("../../../../../GameSentenceMiner/ocr/portable_oneocr.py");

pub(super) struct Engine {
    socket: UnixStream,
    child: Child,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Deserialize)]
struct Node {
    text: String,
    bounding_rect: Rect,
    #[serde(default)]
    words: Vec<Node>,
}
#[derive(Deserialize)]
struct Rect {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    x3: f64,
    y3: f64,
    x4: f64,
    y4: f64,
}
impl Node {
    fn to_box(self) -> TextBox {
        let b = self.bounding_rect;
        let bounds = [
            b.x1.min(b.x2).min(b.x3).min(b.x4),
            b.y1.min(b.y2).min(b.y3).min(b.y4),
            b.x1.max(b.x2).max(b.x3).max(b.x4),
            b.y1.max(b.y2).max(b.y3).max(b.y4),
        ];
        TextBox {
            text: self.text,
            bounds,
            vertical: bounds[3] - bounds[1] > bounds[2] - bounds[0],
            words: self.words.into_iter().map(Node::to_box).collect(),
        }
    }
}
impl Engine {
    pub(super) fn new() -> Result<Self> {
        let python = std::env::var_os("GSM_ONEOCR_PYTHON")
            .map(std::path::PathBuf::from)
            .unwrap_or(crate::models::home()?.join(".config/oneocr/venv/bin/python"));
        let (socket, peer) = UnixStream::pair()?;
        let timeout = Some(Duration::from_secs(60));
        socket.set_read_timeout(timeout)?;
        socket.set_write_timeout(timeout)?;
        let child = Command::new(&python)
            .args(["-I", "-c", WORKER])
            .env("ONEOCR_ORT_ALLOW_INTRA_OP_SPINNING", "0")
            .env(
                "ONEOCR_ORT_INTRA_OP_THREADS",
                std::env::var("ONEOCR_ORT_INTRA_OP_THREADS").unwrap_or_else(|_| "4".into()),
            )
            .stdin(Stdio::from(OwnedFd::from(peer.try_clone()?)))
            .stdout(Stdio::from(OwnedFd::from(peer)))
            .spawn()
            .with_context(|| format!("Set up portable OneOCR at {}", python.display()))?;
        let mut engine = Self { socket, child };
        engine.response().context("Initialize portable OneOCR")?;
        Ok(engine)
    }
    fn response(&mut self) -> Result<serde_json::Value> {
        let mut header = [0; 4];
        self.socket.read_exact(&mut header)?;
        let size = u32::from_le_bytes(header) as usize;
        ensure!(
            (1..=16 * 1024 * 1024).contains(&size),
            "Invalid OneOCR response length"
        );
        let mut bytes = vec![0; size];
        self.socket.read_exact(&mut bytes)?;
        let result: serde_json::Value = serde_json::from_slice(&bytes)?;
        if let Some(error) = result["error"].as_str() {
            bail!("{error}");
        }
        Ok(result)
    }
    pub(super) fn recognize(&mut self, image: &RgbaImage) -> Result<Recognition> {
        self.socket.write_all(&image.width().to_le_bytes())?;
        self.socket.write_all(&image.height().to_le_bytes())?;
        self.socket.write_all(image.as_raw())?;
        let mut result = self.response()?;
        let lines: Vec<Node> = serde_json::from_value(result["lines"].take())?;
        Ok(Recognition::from_lines(
            lines.into_iter().map(Node::to_box).collect(),
        ))
    }
}

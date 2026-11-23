//! Write SRT subtitles beside OBS recordings. All times are UTC microseconds.
use crate::text::sanitize_filename;
use std::{
    fmt::Write as _,
    fs::{self, File},
    io::{self, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const NL: &str = if cfg!(windows) { "\r\n" } else { "\n" };

struct Subtitle {
    path: PathBuf,
    file: File,
    committed: u64,
}

impl Subtitle {
    fn create(target: PathBuf) -> io::Result<Self> {
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut path = target.clone();
        loop {
            match File::create_new(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file,
                        committed: 0,
                    })
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    let stem = target.file_stem().unwrap_or_default().to_string_lossy();
                    path = target.with_file_name(format!("{stem}_{}.srt", uuid::Uuid::new_v4()));
                }
                Err(e) => return Err(e),
            }
        }
    }

    // The temporary profile directory and the user's recordings can be on different volumes.
    fn relocate(&mut self, target: PathBuf) -> io::Result<()> {
        let mut dest = Self::create(target)?;
        let copied = (|| {
            dest.committed = io::copy(&mut File::open(&self.path)?, &mut dest.file)?;
            dest.file.flush()?;
            fs::remove_file(&self.path)
        })();
        if let Err(e) = copied {
            drop(dest.file);
            let _ = fs::remove_file(dest.path);
            return Err(e);
        }
        *self = dest;
        Ok(())
    }

    fn append(&mut self, cue: &[u8]) -> io::Result<()> {
        if let Err(error) = self.file.write_all(cue) {
            // A short write can leave part of a UTF-8 cue on disk. Roll back
            // its bytes before the next finalized observation retries it.
            self.file.set_len(self.committed)?;
            self.file.seek(SeekFrom::Start(self.committed))?;
            return Err(error);
        }
        self.committed += cue.len() as u64;
        Ok(())
    }
}

struct Session {
    start_us: i64,
    recording: Option<PathBuf>,
    subtitle: Option<Subtitle>,
    pending: Option<(i64, Arc<str>)>,
    index: u64,
    buffer: String,
}

impl Session {
    fn new(start_us: i64) -> Self {
        Self {
            start_us,
            recording: None,
            subtitle: None,
            pending: None,
            index: 1,
            buffer: String::new(),
        }
    }

    fn set_path(&mut self, path: &Path) -> io::Result<()> {
        if self.recording.as_deref() == Some(path) {
            return Ok(());
        }
        if let Some(srt) = &mut self.subtitle {
            if srt.path != path.with_extension("srt") {
                srt.relocate(path.with_extension("srt"))?;
            }
        }
        self.recording = Some(path.to_owned());
        Ok(())
    }

    fn write_pending(&mut self, end_us: i64, temp_dir: &Path) -> io::Result<()> {
        let Some((start_us, text)) = &self.pending else {
            return Ok(());
        };
        if end_us < *start_us {
            return Ok(());
        }
        let file = match &mut self.subtitle {
            Some(srt) => srt,
            None => {
                let path = self
                    .recording
                    .as_ref()
                    .map(|p| p.with_extension("srt"))
                    .unwrap_or_else(|| {
                        temp_dir.join(format!("longplay_{}.srt", uuid::Uuid::new_v4()))
                    });
                self.subtitle.insert(Subtitle::create(path)?)
            }
        };
        let start_ms = start_us.saturating_sub(self.start_us).max(0) / 1000;
        let end_ms = (end_us.saturating_sub(self.start_us) / 1000 - 1000).max(start_ms);
        self.buffer.clear();
        write!(
            self.buffer,
            "{}{NL}{} --> {}{NL}",
            self.index,
            Timestamp(start_ms),
            Timestamp(end_ms)
        )
        .unwrap();
        if cfg!(windows) && text.contains('\n') {
            self.buffer.push_str(&text.replace('\n', NL));
        } else {
            self.buffer.push_str(text);
        }
        self.buffer.push_str(NL);
        self.buffer.push_str(NL);
        file.append(self.buffer.as_bytes())?;
        self.index += 1;
        Ok(())
    }

    fn prefix_mp4(&mut self, game: &str) -> io::Result<()> {
        let Some(video) = &self.recording else {
            return Ok(());
        };
        if !video
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
            || !video.try_exists()?
        {
            return Ok(());
        }
        let game = sanitize_filename(game.trim());
        let prefix = if game.is_empty() { "longplay" } else { &game };
        let name = video.file_name().unwrap_or_default().to_string_lossy();
        if name
            .to_lowercase()
            .starts_with(&format!("{}_", prefix.to_lowercase()))
        {
            return Ok(());
        }
        let target = video.with_file_name(format!("{prefix}_{name}"));
        let sidecar = target.with_extension("srt");
        if target.try_exists()? || (self.subtitle.is_some() && sidecar.try_exists()?) {
            return Ok(());
        }
        move_exclusive(video, &target)?;
        if let Some(srt) = &mut self.subtitle {
            if let Err(error) = move_exclusive(&srt.path, &sidecar) {
                move_exclusive(&target, video)?;
                return Err(error);
            }
            srt.path = sidecar;
        }
        self.recording = Some(target);
        Ok(())
    }
}

// Both paths are on the same volume. Reserve the name so a concurrent export
// cannot replace another recording. OBS can briefly retain a Windows file lock.
fn move_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    drop(File::create_new(to)?);
    let mut result = fs::rename(from, to);
    if result.as_ref().is_err_and(|e| {
        e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(32 | 33))
    }) {
        std::thread::sleep(Duration::from_secs(2));
        result = fs::rename(from, to);
    }
    if result.is_err() {
        let _ = fs::remove_file(to);
    }
    result
}

struct Timestamp(i64);
impl std::fmt::Display for Timestamp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ms = self.0;
        write!(
            f,
            "{:02}:{:02}:{:02},{:03}",
            ms / 3_600_000,
            ms / 60_000 % 60,
            ms / 1000 % 60,
            ms % 1000
        )
    }
}

pub struct Recorder {
    temp_dir: PathBuf,
    current: Option<Session>,
    // A STOPPED event can precede the StopRecord response carrying the output path.
    awaiting_path: Option<Session>,
}

impl Recorder {
    pub fn new(temp_dir: PathBuf) -> Self {
        Self {
            temp_dir,
            current: None,
            awaiting_path: None,
        }
    }
    pub fn start(&mut self, at: i64) {
        self.current.get_or_insert_with(|| Session::new(at));
    }
    pub fn active(&self) -> bool {
        self.current.is_some()
    }
    /// On desktop shutdown OBS may still be recording or disconnected.
    /// Finish the cue in place without renaming the active recording.
    pub fn finish_input(&mut self, at: i64) -> io::Result<()> {
        if let Some(s) = &mut self.current {
            s.write_pending(at, &self.temp_dir)?;
            s.pending = None;
        }
        Ok(())
    }
    pub fn line(&mut self, at: i64, text: Arc<str>) -> io::Result<()> {
        if let Some(s) = &mut self.current {
            if at < s.start_us || s.pending.as_ref().is_some_and(|p| at < p.0) {
                return Ok(());
            }
            s.write_pending(at, &self.temp_dir)?;
            s.pending = Some((at, text));
        }
        Ok(())
    }
    pub fn file(&mut self, at: i64, path: &Path, game: &str) -> io::Result<()> {
        self.start(at);
        let s = self.current.as_mut().unwrap();
        if s.recording.as_ref().is_some_and(|p| p != path) {
            s.write_pending(at, &self.temp_dir)?;
            let pending = s.pending.take().map(|(_, t)| (at, t));
            let result = s.prefix_mp4(game);
            *s = Session::new(at);
            s.pending = pending;
            s.set_path(path)?;
            return result;
        }
        s.set_path(path)
    }
    pub fn stop(&mut self, at: i64, path: Option<&Path>, game: &str) -> io::Result<()> {
        if let Some(s) = &mut self.current {
            if let Some(path) = path {
                s.set_path(path)?;
            }
            s.write_pending(at, &self.temp_dir)?;
            s.pending = None;
            let mut s = self.current.take().unwrap();
            self.awaiting_path = None;
            if s.recording.is_some() {
                s.prefix_mp4(game)?;
            } else {
                self.awaiting_path = Some(s);
            }
        } else {
            self.attach_stopped_path(path, game)?;
        }
        Ok(())
    }

    pub fn attach_stopped_path(&mut self, path: Option<&Path>, game: &str) -> io::Result<()> {
        if let (Some(s), Some(path)) = (&mut self.awaiting_path, path) {
            s.set_path(path)?;
            s.prefix_mp4(game)?;
            self.awaiting_path = None;
        }
        Ok(())
    }
}

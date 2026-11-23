//! Discord presence is rate limited independently of text intake. Lines only update a deadline
//! and scene; the worker opens the local Discord IPC socket and reads statistics at publish time.
use super::Intake;
use serde_json::{json, Value};
use std::{
    io,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Notify,
};

trait Pipe: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Pipe for T {}
type Socket = Box<dyn Pipe>;
#[cfg(windows)]
async fn connect() -> io::Result<Socket> {
    Ok(Box::new(
        tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\discord-ipc-0")?,
    ))
}
#[cfg(unix)]
async fn connect() -> io::Result<Socket> {
    let root = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(std::env::var_os)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    for dir in ["", "app/com.discordapp.Discord", "snap.discord"] {
        if let Ok(s) = tokio::net::UnixStream::connect(root.join(dir).join("discord-ipc-0")).await {
            return Ok(Box::new(s));
        }
    }
    Err(io::ErrorKind::NotFound.into())
}
async fn write_frame(s: &mut Socket, op: u32, v: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(v)?;
    let mut frame = Vec::with_capacity(8 + data.len());
    frame.extend(op.to_le_bytes());
    frame.extend((data.len() as u32).to_le_bytes());
    frame.extend(data);
    s.write_all(&frame).await
}
async fn exchange(s: &mut Socket, op: u32, v: &Value) -> io::Result<()> {
    write_frame(s, op, v).await?;
    loop {
        let tag = s.read_u32_le().await?;
        let len = s.read_u32_le().await? as usize;
        if len > 65536 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut data = vec![0; len];
        s.read_exact(&mut data).await?;
        let value: Value = serde_json::from_slice(&data)?;
        match tag {
            3 => write_frame(s, 4, &value).await?,
            1 if value["evt"] == "ERROR" => return Err(io::ErrorKind::InvalidData.into()),
            1 if (op == 0 && value["evt"] == "READY")
                || (op == 1 && value["nonce"] == v["nonce"]) =>
            {
                return Ok(())
            }
            1 | 4 => continue,
            _ => return Err(io::ErrorKind::ConnectionAborted.into()),
        }
    }
}

#[derive(Default)]
pub struct Presence {
    cfg: Value,
    last: Option<Instant>,
    start: i64,
    scene: Arc<str>,
    worker: Option<Arc<Notify>>,
}
impl Drop for Presence {
    fn drop(&mut self) {
        if let Some(n) = &self.worker {
            n.notify_one();
        }
    }
}
impl Presence {
    pub fn configure(&mut self, cfg: &Value) {
        if &self.cfg != cfg {
            self.cfg = cfg.clone();
            if let Some(n) = &self.worker {
                n.notify_one();
            }
        }
    }
    pub fn activity(&mut self, app: &AppHandle, scene: &Arc<str>) {
        if let Some(owner) = self.touch(scene) {
            tauri::async_runtime::spawn(run(app.clone(), owner));
        }
    }
    // Only the first observation starts a task. The worker owns all Discord I/O.
    fn touch(&mut self, scene: &Arc<str>) -> Option<Arc<Notify>> {
        if self.cfg["enabled"] != true {
            return None;
        }
        self.last = Some(Instant::now());
        if self.scene != *scene {
            self.scene = scene.clone();
            if let Some(worker) = &self.worker {
                worker.notify_one();
            }
        }
        if self.worker.is_some() {
            return None;
        }
        self.start = chrono::Utc::now().timestamp();
        let worker = Arc::new(Notify::new());
        self.worker = Some(worker.clone());
        Some(worker)
    }
    fn blacklisted(&self, current_scene: &str) -> bool {
        self.cfg["blacklisted_scenes"]
            .as_array()
            .is_some_and(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|blocked| blocked == current_scene || blocked == self.scene.as_ref())
            })
    }
}
fn grouped(n: u64) -> String {
    let raw = n.to_string();
    let mut s = String::with_capacity(raw.len() + raw.len() / 3);
    for (i, c) in raw.chars().enumerate() {
        if i > 0 && (raw.len() - i).is_multiple_of(3) {
            s.push(',');
        }
        s.push(c);
    }
    s
}
fn activity(p: &Presence, values: &Value) -> Value {
    let (field, suffix) = match p.cfg["show_reading_stats"].as_str() {
        Some("Characters per Hour") => ("chars_per_hour", "char/hr"),
        Some("Total Characters") => ("total_characters", "chars total"),
        Some("Cards Mined") => ("cards_mined", "cards mined"),
        Some("Active Reading Time") => ("active_reading_time", "reading"),
        _ => ("", ""),
    };
    let n = values[field].as_f64().unwrap_or(0.) as u64;
    let state = if n == 0 {
        "Mining sentences...".into()
    } else if field == "active_reading_time" {
        if n >= 3600 {
            format!("{}h {}m reading", n / 3600, n % 3600 / 60)
        } else {
            format!("{}m reading", n / 60)
        }
    } else {
        format!("{} {suffix}", grouped(n))
    };
    let icon = match p.cfg["icon"].as_str() {
        Some("Cute") => "gsm_cute",
        Some("Jacked") => "gsm_jacked",
        Some("Cursed") => "gsm_cursed",
        _ => "gsm",
    };
    let url = "https://github.com/bpwhelan/GameSentenceMiner";
    json!({"type":0,"status_display_type":0,"name":p.scene,"state":state,"state_url":url,"details":"Mining with GameSentenceMiner...",
        "details_url":url,"timestamps":{"start":p.start},"assets":{"large_image":icon,"large_text":"GameSentenceMiner","large_url":url},"instance":true})
}
async fn run(app: AppHandle, owner: Arc<Notify>) {
    let mut socket = None;
    let mut due = Instant::now();
    loop {
        let (wait, update) = {
            let intake = app.state::<Intake>();
            let mut s = intake.state.lock().unwrap();
            let p = &mut s.projection;
            if !p
                .presence
                .worker
                .as_ref()
                .is_some_and(|n| Arc::ptr_eq(n, &owner))
            {
                return;
            }
            let now = Instant::now();
            let until = p.presence.last.unwrap_or(now)
                + Duration::from_secs(
                    p.presence.cfg["inactivity_timer"]
                        .as_u64()
                        .unwrap_or(300)
                        .min(31_536_000),
                );
            if until <= now || p.presence.cfg["enabled"] != true {
                p.presence.worker = None;
                return;
            }
            let blocked = p
                .presence
                .blacklisted(&app.state::<crate::obs::Obs>().current_scene_name());
            if blocked {
                socket = None;
            }
            let update = if now >= due && !blocked && !p.presence.scene.is_empty() {
                Some(activity(&p.presence, &p.live.values()["values"]))
            } else {
                None
            };
            if now >= due {
                due = now
                    + Duration::from_secs(
                        p.presence.cfg["update_interval"]
                            .as_u64()
                            .unwrap_or(15)
                            .clamp(1, 86400),
                    );
            }
            (due.min(until), update)
        };
        if let Some(act) = update {
            let result=tokio::time::timeout(Duration::from_secs(3),async{
                if socket.is_none(){let mut s=connect().await?;exchange(&mut s,0,&json!({"v":1,"client_id":"1441571345942052935"})).await?;socket=Some(s);}
                exchange(socket.as_mut().unwrap(),1,&json!({"cmd":"SET_ACTIVITY","args":{"pid":std::process::id(),"activity":act},"nonce":uuid::Uuid::new_v4().to_string()})).await
            }).await;
            if !matches!(result, Ok(Ok(()))) {
                socket = None;
                due = Instant::now() + Duration::from_secs(20);
            }
        }
        tokio::select! {_=tokio::time::sleep_until(wait.into())=>{},_=owner.notified()=>{due=Instant::now();}}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn handshake_answers_ping_and_waits_for_ready() {
        let (first, second) = tokio::io::duplex(4096);
        let mut client: Socket = Box::new(first);
        let mut mock: Socket = Box::new(second);
        let server = tokio::spawn(async move {
            assert_eq!(mock.read_u32_le().await.unwrap(), 0);
            let len = mock.read_u32_le().await.unwrap();
            let mut body = vec![0; len as usize];
            mock.read_exact(&mut body).await.unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["v"], 1);
            write_frame(&mut mock, 3, &json!({"ping":1})).await.unwrap();
            assert_eq!(mock.read_u32_le().await.unwrap(), 4);
            let len = mock.read_u32_le().await.unwrap();
            let mut body = vec![0; len as usize];
            mock.read_exact(&mut body).await.unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["ping"], 1);
            write_frame(&mut mock, 1, &json!({"evt":"READY"}))
                .await
                .unwrap();
        });
        exchange(&mut client, 0, &json!({"v":1})).await.unwrap();
        server.await.unwrap();
    }
    #[test]
    fn scene_switch_into_a_blacklisted_game_hides_the_previous_presence() {
        let mut p = Presence::default();
        p.configure(&json!({"enabled":true,"blacklisted_scenes":["private"]}));
        let scene: Arc<str> = "game".into();
        assert!(p.touch(&scene).is_some());
        assert!(p.touch(&scene).is_none());
        assert!(p.blacklisted("private"));
        assert!(!p.blacklisted("game"));
    }
    #[test]
    #[ignore = "producer-side Discord deadline benchmark"]
    fn benchmark_presence_activity() {
        let mut p = Presence::default();
        p.configure(&json!({"enabled":true}));
        let scene: Arc<str> = "Game".into();
        assert!(p.touch(&scene).is_some());
        let mut micros = vec![];
        for _ in 0..300 {
            let start = Instant::now();
            for _ in 0..128 {
                std::hint::black_box(p.touch(std::hint::black_box(&scene)));
            }
            micros.push(start.elapsed().as_nanos() as f64 / 128000.);
        }
        micros.sort_by(f64::total_cmp);
        println!(
            "discord_touch_p50_us={} p95_us={}",
            micros[150], micros[285]
        );
    }
}

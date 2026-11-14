//! Direct OBS v5 capture; shared persistent sockets and short frame reuse.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::RgbaImage;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::TcpStream,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};
type Socket = WebSocket<MaybeTlsStream<TcpStream>>;
fn receive(socket: &mut Socket) -> Result<Value, String> {
    loop {
        let message = socket
            .read()
            .map_err(|_| "OBS connection closed or timed out")?;
        if let Message::Text(t) = message {
            return serde_json::from_str(&t).map_err(|_| "Invalid OBS response".into());
        }
    }
}
pub fn authentication(password: &str, salt: &str, challenge: &str) -> String {
    let secret = STANDARD.encode(Sha256::digest(format!("{password}{salt}")));
    STANDARD.encode(Sha256::digest(format!("{secret}{challenge}")))
}
struct Session {
    socket: Socket,
    cached: Option<(String, Instant, Arc<RgbaImage>)>,
    next: u64,
}
impl Session {
    fn new(config: &Value) -> Result<Self, String> {
        let host = config["host"].as_str().unwrap_or("127.0.0.1");
        let port = config["port"].as_u64().unwrap_or(4455);
        use std::net::ToSocketAddrs;
        let addr = (host, port as u16)
            .to_socket_addrs()
            .map_err(|_| "Cannot resolve OBS host")?
            .next()
            .ok_or("No OBS address")?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
            .map_err(|_| "Cannot connect to OBS")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        let (mut socket, _) =
            tungstenite::client(format!("ws://{host}:{port}"), MaybeTlsStream::Plain(stream))
                .map_err(|_| "OBS WebSocket handshake failed")?;
        let hello = receive(&mut socket)?;
        if hello["op"] != 0 {
            return Err("OBS did not send a v5 greeting".into());
        }
        let mut identify = json!({"op":1,"d":{"rpcVersion":1,"eventSubscriptions":0}});
        if let Some(auth) = hello["d"]["authentication"].as_object() {
            identify["d"]["authentication"] = json!(authentication(
                config["password"].as_str().unwrap_or(""),
                auth["salt"].as_str().unwrap_or(""),
                auth["challenge"].as_str().unwrap_or("")
            ));
        }
        socket
            .send(Message::Text(identify.to_string().into()))
            .map_err(|_| "Cannot identify with OBS")?;
        if receive(&mut socket)?["op"] != 2 {
            return Err("OBS authentication failed".into());
        }
        Ok(Self {
            socket,
            cached: None,
            next: 0,
        })
    }
    fn grab(&mut self, source: &str) -> Result<Arc<RgbaImage>, String> {
        if let Some((name, at, image)) = &self.cached {
            if name == source && at.elapsed() < Duration::from_millis(16) {
                return Ok(image.clone());
            }
        }
        self.next += 1;
        let id = self.next.to_string();
        let request = json!({"op":6,"d":{"requestType":"GetSourceScreenshot","requestId":id,"requestData":{"sourceName":source,"imageFormat":"png"}}});
        self.socket
            .send(Message::Text(request.to_string().into()))
            .map_err(|_| "OBS screenshot request failed")?;
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            let response = receive(&mut self.socket)?;
            if response["op"] != 7 || response["d"]["requestId"] != id {
                continue;
            }
            let d = &response["d"];
            if d["requestStatus"]["result"] != true {
                return Err(format!(
                    "OBS screenshot failed: {}",
                    d["requestStatus"]["code"]
                ));
            }
            let data = d["responseData"]["imageData"]
                .as_str()
                .ok_or("Missing OBS screenshot")?;
            let data = STANDARD
                .decode(data.split_once(',').ok_or("Invalid OBS screenshot")?.1)
                .map_err(|_| "Invalid screenshot encoding")?;
            let image = Arc::new(
                image::load_from_memory(&data)
                    .map_err(|e| e.to_string())?
                    .into_rgba8(),
            );
            self.cached = Some((source.into(), Instant::now(), image.clone()));
            return Ok(image);
        }
        Err("Timed out waiting for OBS screenshot".into())
    }
}
#[derive(Default)]
pub struct Capture {
    key: String,
    session: Option<Arc<Mutex<Session>>>,
}
impl Capture {
    pub fn clear(&mut self) {
        self.session = None;
        self.key.clear();
    }
    pub fn grab(&mut self, config: &Value, source: &str) -> Result<Arc<RgbaImage>, String> {
        static REGISTRY: OnceLock<Mutex<std::collections::HashMap<String, Weak<Mutex<Session>>>>> =
            OnceLock::new();
        let key = config.to_string();
        if self.key != key || self.session.is_none() {
            self.clear();
            let mut registry = REGISTRY.get_or_init(Default::default).lock().unwrap();
            registry.retain(|_, s| s.strong_count() > 0);
            let session = if let Some(s) = registry.get(&key).and_then(Weak::upgrade) {
                s
            } else {
                let s = Arc::new(Mutex::new(Session::new(config)?));
                registry.insert(key.clone(), Arc::downgrade(&s));
                s
            };
            self.key = key;
            self.session = Some(session);
        }
        let result = self.session.as_ref().unwrap().lock().unwrap().grab(source);
        if result.is_err() {
            let mut registry = REGISTRY.get().unwrap().lock().unwrap();
            if registry.get(&self.key).is_some_and(|registered| {
                Weak::ptr_eq(registered, &Arc::downgrade(self.session.as_ref().unwrap()))
            }) {
                registry.remove(&self.key);
            }
            drop(registry);
            self.clear();
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_protocol_socket_authentication_reuse_and_independent_drop() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            ws.send(Message::Text(
                json!({"op":0,"d":{"authentication":{"salt":"salt","challenge":"challenge"}}})
                    .to_string()
                    .into(),
            ))
            .unwrap();
            let auth: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(
                auth["d"]["authentication"],
                authentication("test-password", "salt", "challenge")
            );
            ws.send(Message::Text(json!({"op":2,"d":{}}).to_string().into()))
                .unwrap();
            let mut png = std::io::Cursor::new(Vec::new());
            RgbaImage::from_pixel(10, 5, image::Rgba([1, 2, 3, 255]))
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
            for _ in 0..2 {
                let request: Value =
                    serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
                assert_eq!(request["d"]["requestType"], "GetSourceScreenshot");
                assert_eq!(request["d"]["requestData"]["sourceName"], "Video source");
                ws.send(Message::Text(json!({"op":7,"d":{"requestId":request["d"]["requestId"],"requestStatus":{"result":true},"responseData":{"imageData":format!("data:image/png;base64,{}",STANDARD.encode(png.get_ref()))}}}).to_string().into())).unwrap();
            }
        });
        let config = json!({"host":"127.0.0.1","port":port,"password":"test-password"});
        let (mut a, mut b) = (Capture::default(), Capture::default());
        let first = a.grab(&config, "Video source").unwrap();
        let second = b.grab(&config, "Video source").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.dimensions(), (10, 5));
        a.clear();
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(
            b.grab(&config, "Video source").unwrap().get_pixel(0, 0).0,
            [1, 2, 3, 255]
        );
        b.clear();
        server.join().unwrap();
    }
}

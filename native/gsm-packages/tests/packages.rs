use gsm_packages::{
    engines::{Engines, SENTINELS},
    scripts::{hashes, preserve, Scripts},
};
use gsm_settings::{read_object, write_atomic};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, data) in files {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(routes: HashMap<String, Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = [0; 8192];
                    let count = stream.read(&mut bytes).unwrap_or(0);
                    let request = String::from_utf8_lossy(&bytes[..count]);
                    let path = request.split_whitespace().nth(1).unwrap_or("");
                    let body = routes.get(path);
                    let data = body.map(Vec::as_slice).unwrap_or(b"missing");
                    let response = format!(
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        if body.is_some() {
                            "200 OK"
                        } else {
                            "404 Not Found"
                        },
                        data.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(data);
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        });
        Self {
            url,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn engine_server(corrupt: bool) -> Server {
    let bytes = archive(
        &SENTINELS
            .iter()
            .map(|s| (*s, b"fixture".as_slice()))
            .collect::<Vec<_>>(),
    );
    let releases:Vec<_>=["1.0.0","2.0.0"].iter().map(|version|json!({"version":version,"archive":{"path":format!("versions/{version}/texthook.zip"),"sha256":if corrupt {"0".repeat(64)}else{digest(&bytes)}},"files":SENTINELS.iter().map(|s|json!({"path":s,"sha256":digest(b"fixture")})).collect::<Vec<_>>()})).collect();
    Server::new(HashMap::from([
        (
            "/texthook_manifest_v2.json".into(),
            serde_json::to_vec(
                &json!({"schemaVersion":2,"recommendedVersion":"2.0.0","releases":releases}),
            )
            .unwrap(),
        ),
        ("/versions/1.0.0/texthook.zip".into(), bytes.clone()),
        ("/versions/2.0.0/texthook.zip".into(), bytes),
    ]))
}
#[test]
fn engine_install_pin_tamper_and_repair_preserve_active_generation() {
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    let legacy = engines.root.join("profiles.json");
    write_atomic(
        &legacy,
        &json!({"game.exe":{"exeName":"game.exe","engine":"mages"}}),
    )
    .unwrap();
    let profile = fs::read(&legacy).unwrap();
    let first = engines.prepare(None, &|_, _| {}).unwrap();
    assert!(!engines.installed());
    engines.activate(&first).unwrap();
    let active = engines.runtime_dir();
    assert_eq!(engines.local_status()["version"], "2.0.0");
    engines.discard(&first).unwrap();
    assert!(active.exists());
    let tampered = engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap();
    fs::write(tampered.directory.join(SENTINELS[0]), b"changed").unwrap();
    assert!(engines.activate(&tampered).is_err());
    assert_eq!(engines.runtime_dir(), active);
    engines.discard(&tampered).unwrap();
    let pin = engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap();
    engines.activate(&pin).unwrap();
    assert_eq!(engines.local_status()["version"], "1.0.0");
    assert!(active.exists());
    fs::remove_file(pin.directory.join(SENTINELS[0])).unwrap();
    let repair = engines.prepare(None, &|_, _| {}).unwrap();
    assert_eq!(repair.manifest["version"], "1.0.0");
    assert_eq!(fs::read(legacy).unwrap(), profile);
}
#[test]
fn bad_archive_and_unknown_version_never_publish() {
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(true);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    assert!(engines.prepare(None, &|_, _| {}).is_err());
    assert!(engines.prepare(Some("3.0.0"), &|_, _| {}).is_err());
    assert!(!engines.root.join("texthook_manifest.json").exists());
}
#[test]
fn rejects_unexpected_archive_paths() {
    let dir = tempfile::tempdir().unwrap();
    let zip = dir.path().join("archive.zip");
    fs::write(&zip, archive(&[("../escape", b"bad")])).unwrap();
    assert!(gsm_packages::extract(&zip, &dir.path().join("stage"), None).is_err());
    assert!(!dir.path().join("escape").exists());
}
#[test]
fn local_agent_changes_are_never_reenrolled() {
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("local");
    let next = dir.path().join("next");
    fs::create_dir_all(&local).unwrap();
    fs::create_dir_all(&next).unwrap();
    for name in ["game.js", "untouched.js", "removed.js"] {
        fs::write(local.join(name), b"old").unwrap();
    }
    let old = hashes(&local).unwrap();
    fs::write(local.join("game.js"), b"my edit").unwrap();
    fs::write(local.join("custom.js"), b"mine").unwrap();
    for name in ["game.js", "untouched.js"] {
        fs::write(next.join(name), b"new").unwrap();
    }
    let mut managed = hashes(&next).unwrap();
    preserve(&local, &next, &old, &mut managed).unwrap();
    assert_eq!(fs::read(next.join("game.js")).unwrap(), b"my edit");
    assert_eq!(fs::read(next.join("custom.js")).unwrap(), b"mine");
    assert_eq!(fs::read(next.join("untouched.js")).unwrap(), b"new");
    assert!(!next.join("removed.js").exists());
    assert!(!managed.contains_key("game.js"));
    assert!(!managed.contains_key("custom.js"));
}
fn scripts_server() -> Server {
    let commit = "a".repeat(40);
    let bytes = archive(&[
        ("repo/libLoader.js", b"loader"),
        ("repo/game.js", b"upstream"),
    ]);
    Server::new(HashMap::from([
        (
            "/".into(),
            serde_json::to_vec(&json!({"default_branch":"main"})).unwrap(),
        ),
        (
            "/commits/main".into(),
            serde_json::to_vec(&json!({"sha":commit})).unwrap(),
        ),
        (format!("/zipball/{commit}"), bytes),
    ]))
}
#[test]
fn agent_update_keeps_edits_metadata_and_offline_copy() {
    let dir = tempfile::tempdir().unwrap();
    let server = scripts_server();
    let mut scripts = Scripts::new(dir.path());
    scripts.api = server.url.clone();
    assert_eq!(scripts.ensure(false).unwrap()["updated"], true);
    fs::write(scripts.directory().join("game.js"), b"edited").unwrap();
    fs::write(scripts.directory().join("custom.mjs"), b"custom").unwrap();
    assert_eq!(scripts.ensure(true).unwrap()["updated"], true);
    assert_eq!(
        fs::read(scripts.directory().join("game.js")).unwrap(),
        b"edited"
    );
    assert!(scripts.directory().join("custom.mjs").exists());
    assert!(
        read_object(&scripts.root.join("metadata.json")).unwrap()["fileHashes"]["game.js"]
            .is_null()
    );
    drop(server);
    assert_eq!(scripts.ensure(true).unwrap()["installed"], true);
}
#[test]
fn data_paths_read_existing_pointer_without_rewriting() {
    let dir = tempfile::tempdir().unwrap();
    let pointer = dir.path().join("bootstrap/data_dir.json");
    let custom = dir.path().join("custom");
    write_atomic(&pointer, &json!({"version":2,"dataDir":custom,"future":42})).unwrap();
    let bytes = fs::read(&pointer).unwrap();
    assert_eq!(
        gsm_settings::paths::installed(&pointer, &dir.path().join("default"), true).unwrap(),
        custom
    );
    assert_eq!(fs::read(pointer).unwrap(), bytes);
}

#[test]
fn failed_update_check_returns_a_complete_ui_snapshot() {
    use gsm_packages::updates::Updater;
    use gsm_settings::preferences::Preferences;
    let dir = tempfile::tempdir().unwrap();
    let server = Server::new(HashMap::new());
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    let updater = Updater::new(engines, Preferences::new(dir.path()), || false, |_| {});
    let result = updater
        .spawn("check".into(), json!(null))
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(result["phase"], "error");
    assert_eq!(result["installed"], false);
    assert_eq!(result["automatic"], true);
    assert!(result["error"].is_string());
}

#[test]
fn native_timer_activates_after_capture_stops_and_excludes_new_attachments() {
    use gsm_packages::updates::Updater;
    use gsm_settings::preferences::Preferences;
    use std::time::{Duration, Instant};
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    engines
        .activate(&engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap())
        .unwrap();
    let busy = Arc::new(AtomicBool::new(true));
    let busy_check = busy.clone();
    let proceed = Arc::new(AtomicBool::new(false));
    let allow_install = proceed.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let updater = Updater::new(
        engines.clone(),
        Preferences::new(dir.path()),
        move || busy_check.load(Ordering::SeqCst),
        move |state| {
            if state["phase"] == "installing" {
                tx.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !allow_install.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        },
    );
    assert_eq!(
        updater
            .spawn("download".into(), json!(null))
            .recv_timeout(Duration::from_secs(10))
            .unwrap()["deferred"],
        true
    );
    updater.start();
    busy.store(false, Ordering::SeqCst);
    rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(
        updater.reserve().is_err(),
        "Native activation excludes a new attachment"
    );
    assert_eq!(
        updater
            .spawn("download".into(), json!(null))
            .recv()
            .unwrap()["success"],
        false
    );
    assert_eq!(
        updater.spawn("check".into(), json!(null)).recv().unwrap()["phase"],
        "installing"
    );
    proceed.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(10);
    while updater.snapshot()["phase"] != "idle" && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(engines.local_status()["version"], "2.0.0");
    let lease = updater.lease().unwrap();
    drop(lease);
    updater.shutdown();
    assert!(updater.reserve().is_err());
}

#[test]
fn native_updates_defer_activation_and_persist_explicit_pin() {
    use gsm_packages::updates::Updater;
    use gsm_settings::preferences::Preferences;
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    let initial = engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap();
    engines.activate(&initial).unwrap();
    let prefs = Preferences::new(dir.path());
    prefs.patch(&json!({"unrelated":{"keep":true}})).unwrap();
    let updater = Updater::new(engines.clone(), prefs.clone(), || false, |_| {});
    let reservation = updater.reserve().unwrap();
    let result = updater
        .spawn("version".into(), json!("2.0.0"))
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(result["deferred"], true);
    assert_eq!(engines.local_status()["version"], "1.0.0");
    assert_eq!(prefs.get("autoUpdateTexthook").unwrap(), Some(json!(false)));
    assert_eq!(prefs.get("unrelated.keep").unwrap(), Some(json!(true)));
    updater.release(&reservation);
    assert_eq!(
        updater
            .spawn("apply".into(), json!(null))
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()["success"],
        true
    );
    assert_eq!(engines.local_status()["version"], "2.0.0");
    assert_eq!(updater.snapshot()["phase"], "idle");
}

#[test]
fn native_checks_respect_opt_out_and_do_not_install_unused_hooks() {
    use gsm_packages::updates::Updater;
    use gsm_settings::preferences::Preferences;
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    let prefs = Preferences::new(dir.path());
    let updater = Updater::new(engines.clone(), prefs, || false, |_| {});
    let request = |action: &str| {
        updater
            .spawn(action.into(), json!(null))
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
    };
    assert_eq!(request("checkAuto")["installed"], false);
    assert!(!engines.root.join("packages").exists());
    engines
        .activate(&engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap())
        .unwrap();
    assert_eq!(request("check")["version"], "1.0.0");
    updater.set_automatic(false).unwrap();
    assert_eq!(request("checkAuto")["version"], "1.0.0");
    assert_eq!(request("download")["success"], true);
    assert_eq!(engines.local_status()["version"], "2.0.0");
}

#[test]
fn explicit_version_replaces_a_queued_automatic_update_and_allows_downgrade() {
    use gsm_packages::updates::Updater;
    use gsm_settings::preferences::Preferences;
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    engines
        .activate(&engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap())
        .unwrap();
    let busy = Arc::new(AtomicBool::new(true));
    let busy_check = busy.clone();
    let updater = Updater::new(
        engines.clone(),
        Preferences::new(dir.path()),
        move || busy_check.load(Ordering::SeqCst),
        |_| {},
    );
    let request = |action: &str, args| {
        updater
            .spawn(action.into(), args)
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()
    };
    let automatic = request("checkAuto", json!(null));
    assert_eq!(automatic["pendingVersion"], "2.0.0", "{automatic}");
    assert_eq!(request("version", json!("1.0.0"))["deferred"], true);
    assert_eq!(updater.snapshot()["pendingVersion"], "1.0.0");
    busy.store(false, Ordering::SeqCst);
    assert_eq!(request("apply", json!(null))["success"], true);
    assert_eq!(engines.local_status()["version"], "1.0.0");
    assert_eq!(request("version", json!("2.0.0"))["success"], true);
    assert_eq!(request("version", json!("1.0.0"))["success"], true);
    assert_eq!(engines.local_status()["version"], "1.0.0");
    assert_eq!(updater.snapshot()["automatic"], false);
}

#[test]
fn native_updates_cancel_automatic_pending_install_and_recover_from_failure() {
    use gsm_packages::updates::Updater;
    use gsm_settings::preferences::Preferences;
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    let initial = engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap();
    engines.activate(&initial).unwrap();
    let busy = Arc::new(AtomicBool::new(true));
    let busy_check = busy.clone();
    let updater = Updater::new(
        engines.clone(),
        Preferences::new(dir.path()),
        move || busy_check.load(Ordering::SeqCst),
        |_| {},
    );
    let state = updater
        .spawn("checkAuto".into(), json!(null))
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(state["phase"], "waiting");
    updater.set_automatic(false).unwrap();
    busy.store(false, Ordering::SeqCst);
    let result = updater
        .spawn("apply".into(), json!(null))
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(engines.local_status()["version"], "1.0.0");
    assert!(updater.snapshot()["pendingVersion"].is_null());
    assert_eq!(
        updater
            .spawn("version".into(), json!("bad-version"))
            .recv()
            .unwrap()["success"],
        false
    );
    assert_eq!(
        updater
            .spawn("download".into(), json!(null))
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap()["success"],
        true
    );
    assert_eq!(engines.local_status()["version"], "2.0.0");
}

#[test]
fn automatic_activation_cannot_downgrade_a_newer_install() {
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    let mut old = engines.prepare(Some("1.0.0"), &|_, _| {}).unwrap();
    old.allow_downgrade = false;
    let new = engines.prepare(None, &|_, _| {}).unwrap();
    engines.activate(&new).unwrap();
    assert!(engines.activate(&old).is_err());
    assert_eq!(engines.local_status()["version"], "2.0.0");
}
#[test]
fn pointer_commit_failure_does_not_damage_legacy_install_or_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let server = engine_server(false);
    let mut engines = Engines::new(dir.path());
    engines.base_url = server.url.clone();
    for name in SENTINELS {
        let path = engines.root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"legacy").unwrap();
    }
    let prepared = engines.prepare(None, &|_, _| {}).unwrap();
    fs::create_dir(engines.root.join("texthook_manifest.json")).unwrap();
    assert!(engines.activate(&prepared).is_err());
    assert!(engines.installed());
    assert_eq!(
        fs::read(engines.root.join(SENTINELS[0])).unwrap(),
        b"legacy"
    );
}
#[test]
fn catalog_cannot_target_user_files_or_omit_required_runtime_files() {
    let mut manifest = json!({"version":"1.0.0","files":SENTINELS.iter().map(|s|json!({"path":s,"sha256":digest(b"fixture")})).collect::<Vec<_>>()});
    manifest["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":"profiles.json","sha256":digest(b"overwrite")}));
    assert!(gsm_packages::engines::validate_manifest(&manifest).is_err());
    manifest["files"].as_array_mut().unwrap().pop();
    manifest["files"].as_array_mut().unwrap().pop();
    assert!(gsm_packages::engines::validate_manifest(&manifest).is_err());
}
#[test]
fn archive_cannot_contain_symlinks_or_case_collisions() {
    let dir = tempfile::tempdir().unwrap();
    let zip = dir.path().join("link.zip");
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .add_symlink(
            "link",
            "../outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    fs::write(&zip, writer.finish().unwrap().into_inner()).unwrap();
    assert!(gsm_packages::extract(&zip, &dir.path().join("stage"), None).is_err());
    fs::write(&zip, archive(&[("same.js", b"one"), ("SAME.js", b"two")])).unwrap();
    assert!(gsm_packages::extract(&zip, &dir.path().join("stage2"), None).is_err());
}
#[test]
fn interrupted_agent_directory_switch_restores_original_before_update() {
    let dir = tempfile::tempdir().unwrap();
    let mut scripts = Scripts::new(dir.path());
    scripts.api = "http://127.0.0.1:1".into();
    let backup = scripts.root.join("scripts-old-fixture");
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("custom.js"), b"original").unwrap();
    fs::create_dir(scripts.directory()).unwrap();
    fs::write(scripts.directory().join("game.js"), b"interrupted").unwrap();
    let metadata = json!({"repository":"0xDC00/scripts","branch":"main","commit":"a".repeat(40),"installedAt":1,"checkedAt":gsm_settings::profiles::now(),"scriptCount":1,"fileHashes":{}});
    write_atomic(
        &scripts.root.join("transaction.json"),
        &json!({"backup":"scripts-old-fixture","previousMetadata":metadata}),
    )
    .unwrap();
    assert_eq!(scripts.ensure(false).unwrap()["installed"], true);
    assert_eq!(
        fs::read(scripts.directory().join("custom.js")).unwrap(),
        b"original"
    );
    assert!(!scripts.directory().join("game.js").exists());
    assert!(!scripts.root.join("transaction.json").exists());
}

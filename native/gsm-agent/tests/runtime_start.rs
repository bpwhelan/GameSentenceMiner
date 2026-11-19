use gsm_agent::Controller;
use serde_json::json;
use std::{fs, path::PathBuf};

#[test]
fn stop_during_runtime_preparation_never_launches_the_helper() {
    let directory =
        std::env::temp_dir().join(format!("gsm-runtime-start-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("game.js"), "// fixture").unwrap();
    fs::write(directory.join("libLoader.js"), "// fixture").unwrap();
    let controller = Controller::new(|_, _, _| {});
    let options = json!({"baseDir": directory, "scriptPath": directory.join("game.js"), "pid":123});
    let result = controller.start_with(options.clone(), || {
        controller.stop()?;
        Ok(PathBuf::from("must-not-be-launched"))
    });
    assert_eq!(result.unwrap_err(), "Agent startup cancelled");
    assert!(controller.state()["status"].is_null());
    let failure = controller.start_with(options, || Err("download failed".into()));
    assert_eq!(failure.unwrap_err(), "download failed");
    assert!(controller.state()["status"].is_null());
    fs::remove_dir_all(directory).unwrap();
}

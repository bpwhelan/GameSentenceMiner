//! Opt-in real package maintenance, isolated from the user's Python and cache.
use gsm_packages::python::{Events, Python};
use serde_json::json;
use std::{fs, sync::Arc};

#[test]
#[ignore = "Creates a managed Python environment and downloads fixture dependencies"]
fn real_native_maintenance_preserves_profiles_and_replaces_damaged_files() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("data");
    let project = directory.path().join("project");
    fs::create_dir_all(project.join("GameSentenceMiner")).unwrap();
    fs::create_dir_all(&base).unwrap();
    std::env::set_var("UV_CACHE_DIR", directory.path().join("uv-cache"));
    fs::write(
        project.join("GameSentenceMiner/__init__.py"),
        "FIXTURE = True\n",
    )
    .unwrap();
    fs::write(project.join("pyproject.toml"),"[project]\nname='GameSentenceMiner'\nversion='2026.11.0'\nrequires-python='>=3.13'\ndependencies=['onnxruntime']\n[build-system]\nrequires=['setuptools']\nbuild-backend='setuptools.build_meta'\n").unwrap();
    fs::write(project.join(".python-version"), "3.13.2\n").unwrap();
    let preserved = [
        base.join("config.json"),
        base.join("electron/config.json"),
        base.join("texthook/profiles.json"),
    ];
    for file in &preserved {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, b"{\"preserve\":true}\n").unwrap();
    }
    let python = Python::new(&base, &project, true);
    let events: Events = Arc::new(|event, data| {
        if event == "stage" {
            eprintln!("{} {}", data["stageId"], data["status"]);
        }
    });
    let executable = python.call("ensure", &json!({}), events.clone()).unwrap();
    python
        .call(
            "ensureUv",
            &json!({"pythonPath":executable}),
            events.clone(),
        )
        .unwrap();
    python
        .call(
            "command",
            &json!({"command":executable,"args":["-m","uv","lock","--project",project]}),
            events.clone(),
        )
        .unwrap();
    let manifest = fs::read(project.join("pyproject.toml")).unwrap();
    let lock = fs::read(project.join("uv.lock")).unwrap();
    let repaired = python
        .call("maintain", &json!({"mode":"repair"}), events.clone())
        .unwrap();
    assert_eq!(repaired["installedVersion"], "2026.11.0");
    let installed=python.call("command",&json!({"command":executable,"cwd":base,"args":["-c","import GameSentenceMiner; print(GameSentenceMiner.__file__)"]}),events.clone()).unwrap();
    let installed = std::path::PathBuf::from(installed.as_str().unwrap().trim());
    assert!(
        fs::canonicalize(&installed)
            .unwrap()
            .starts_with(fs::canonicalize(base.join("python_venv")).unwrap()),
        "{}",
        installed.display()
    );
    fs::write(&installed, "raise RuntimeError('damaged fixture')\n").unwrap();
    python
        .call(
            "maintain",
            &json!({"mode":"startup_repair"}),
            events.clone(),
        )
        .unwrap();
    assert!(fs::read_to_string(installed)
        .unwrap()
        .contains("FIXTURE = True"));
    python
        .call(
            "maintain",
            &json!({"mode":"reset_dependencies"}),
            events.clone(),
        )
        .unwrap();
    assert_eq!(
        python
            .call("maintain", &json!({"mode":"update"}), events.clone())
            .unwrap()["changed"],
        false
    );
    assert_eq!(
        python
            .call(
                "maintain",
                &json!({"mode":"update","force":true}),
                events.clone()
            )
            .unwrap()["changed"],
        true
    );
    assert_eq!(
        python.call("info", &json!({}), events.clone()).unwrap()["success"],
        true
    );
    assert_eq!(
        python.call("packages", &json!({}), events).unwrap()["success"],
        true
    );
    assert_eq!(fs::read(project.join("pyproject.toml")).unwrap(), manifest);
    assert_eq!(fs::read(project.join("uv.lock")).unwrap(), lock);
    for file in preserved {
        assert_eq!(fs::read(file).unwrap(), b"{\"preserve\":true}\n");
    }
}

use super::{GameLaunchCommand, GameLaunchOptions};
use std::path::Path;
use steamlocate::{Library, SteamDir};

/// Only inspect manifests in the registered library that contains the executable.
/// Two manifests can share an install folder, in which case keep the direct launch.
fn steam_app(
    executable: &Path,
    locate: impl FnOnce() -> Option<SteamDir>,
) -> Option<(SteamDir, u32)> {
    let game_dir = executable.parent()?.ancestors().find(|dir| {
        let Some(common) = dir.parent() else {
            return false;
        };
        common
            .file_name()
            .is_some_and(|s| s.eq_ignore_ascii_case("common"))
            && common
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|s| s.eq_ignore_ascii_case("steamapps"))
    })?;
    let install_name = game_dir.file_name()?.to_str()?.to_lowercase();
    let library_root = game_dir.parent()?.parent()?.parent()?.canonicalize().ok()?;
    let steam = locate()?;
    if !steam.path().join("steam.exe").is_file()
        || !steam
            .library_paths()
            .ok()?
            .iter()
            .any(|p| p.canonicalize().ok().as_ref() == Some(&library_root))
    {
        return None;
    }

    let library = Library::from_dir(&library_root).ok()?;
    let mut matches = library.app_ids().iter().copied().filter(|&id| {
        library.app(id).and_then(Result::ok).is_some_and(|app| {
            id != 0 && app.app_id == id && app.install_dir.to_lowercase() == install_name
        })
    });
    let id = matches.next()?;
    matches.next().is_none().then_some((steam, id))
}

pub(super) fn route_launch(
    options: &GameLaunchOptions,
    command: &mut GameLaunchCommand,
    locate: impl FnOnce() -> Option<SteamDir>,
) {
    if options.mode == "yuzu" || !options.launcher_path.is_empty() {
        return;
    }
    if let Some((steam, id)) = steam_app(Path::new(&options.executable_path), locate) {
        command.executable = steam
            .path()
            .join("steam.exe")
            .to_string_lossy()
            .into_owned();
        command
            .args
            .splice(..0, ["-applaunch".into(), id.to_string()]);
        if options.working_directory.is_empty() {
            command.cwd = steam.path().to_string_lossy().into_owned();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_launcher::build_game_launch_command;
    use std::{fs, path::Path};

    #[test]
    fn routes_nested_game_in_secondary_library_and_preserves_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path().join("client");
        let library = temp.path().join("other library");
        let steamapps = library.join("steamapps");
        let game = steamapps.join("common/試遊版/bin/trial.exe");
        fs::create_dir_all(game.parent().unwrap()).unwrap();
        fs::write(&game, []).unwrap();
        fs::create_dir_all(client.join("steamapps")).unwrap();
        fs::write(client.join("steam.exe"), []).unwrap();
        let vdf_path = library.to_str().unwrap().replace('\\', "/");
        fs::write(
            client.join("steamapps/libraryfolders.vdf"),
            format!(r#""libraryfolders" {{ "1" {{ "path" "{vdf_path}" }} }}"#),
        )
        .unwrap();
        let manifest = |id, dir| {
            fs::write(
                steamapps.join(format!("appmanifest_{id}.acf")),
                format!(r#""AppState" {{ "appid" "{id}" "installdir" "{dir}" }}"#),
            )
            .unwrap()
        };
        manifest(12, "試遊版 Deluxe");
        manifest(34, "試遊版");
        fs::write(steamapps.join("appmanifest_56.acf"), b"broken").unwrap();
        let opts = GameLaunchOptions {
            executable_path: game.to_str().unwrap().into(),
            arguments: r#"--title "two words""#.into(),
            ..Default::default()
        };
        let resolve = |opts: &GameLaunchOptions| {
            let mut command = build_game_launch_command(opts).unwrap();
            route_launch(opts, &mut command, || SteamDir::from_dir(&client).ok());
            command
        };
        let command = resolve(&opts);
        assert_eq!(Path::new(&command.executable), client.join("steam.exe"));
        assert_eq!(command.args, ["-applaunch", "34", "--title", "two words"]);
        assert_eq!(Path::new(&command.cwd), client);
        for override_opts in [
            GameLaunchOptions {
                launcher_path: "custom.exe".into(),
                ..opts.clone()
            },
            GameLaunchOptions {
                mode: "yuzu".into(),
                ..opts.clone()
            },
        ] {
            assert_eq!(
                resolve(&override_opts),
                build_game_launch_command(&override_opts).unwrap()
            );
        }
        manifest(78, "試遊版");
        assert_eq!(resolve(&opts), build_game_launch_command(&opts).unwrap());
        fs::remove_file(steamapps.join("appmanifest_34.acf")).unwrap();
        fs::remove_file(steamapps.join("appmanifest_78.acf")).unwrap();
        assert_eq!(resolve(&opts), build_game_launch_command(&opts).unwrap());
        manifest(90, "試遊版");
        fs::write(
            client.join("steamapps/libraryfolders.vdf"),
            r#""libraryfolders" {}"#,
        )
        .unwrap();
        assert_eq!(resolve(&opts), build_game_launch_command(&opts).unwrap());
    }

    #[test]
    fn standalone_game_skips_steam_lookup() {
        let opts = GameLaunchOptions {
            executable_path: r"C:\Games\demo\trial.exe".into(),
            ..Default::default()
        };
        let direct = build_game_launch_command(&opts).unwrap();
        let mut command = direct.clone();
        route_launch(&opts, &mut command, || panic!("Unexpected Steam lookup"));
        assert_eq!(command, direct);
    }
}

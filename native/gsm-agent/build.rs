//! Pin the native ABI and verify the official devkit before extraction. No
//! Node bindings or system-wide SDK installation are needed. This builds the
//! separately downloadable runtime; the desktop does not link or bundle Frida.
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf, process::Command};
fn run(mut command: Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .expect("Cannot run the devkit download/extraction tool");
    assert!(
        output.status.success(),
        "Frida devkit preparation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_RUNTIME").is_none() {
        return;
    }
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let arch = match arch.as_str() {
        "aarch64" => "arm64",
        "x86" => "x86",
        other => other,
    };
    let key = format!("{os}-{arch}");
    let checksum = match key.as_str() {
        "windows-x86_64" => "1adf13bf929dcb354cfda8975f865cfb2c2be0e427e90b2bbcb91841b5fe6b14",
        "windows-x86" => "bf85d95c7bcdd3c582dde22152d26d86761a19167cd33de12b647022968ab059",
        "windows-arm64" => "976bfda9fcfd1e952c7b033b6c9144dadcd73d4c61359b22686f6e5a37523116",
        "linux-x86_64" => "d6f0f44fc4f9a6b3e0b8f52779b1cd9e6595c511b8cbcc78fe4dd065f8ff0cf2",
        "macos-arm64" => "f56a015db5e2421f3dabcc622cba0fa53aa5ba48b7e1fc45b3c6f889b25d8277",
        "macos-x86_64" => "0515cb584b85bd5d997fc100a93bb78d5cf114d602a159b3255d0045d8d5eed4",
        _ => panic!("No verified Frida devkit for {key}"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let kit = out.join("frida");
    fs::create_dir_all(&kit).unwrap();
    let library = if os == "windows" {
        "frida-core.lib"
    } else {
        "libfrida-core.a"
    };
    if !kit.join(library).is_file() {
        let filename = format!("frida-core-devkit-17.16.4-{key}.tar.xz");
        let archive = out.join(&filename);
        if !archive.is_file() {
            println!("cargo:warning=Downloading pinned Frida 17.16.4 native devkit for {key}");
            let mut curl = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
            curl.args([
                "--fail",
                "--location",
                "--retry",
                "3",
                "--max-time",
                "180",
                "--output",
            ])
            .arg(&archive)
            .arg(format!(
                "https://github.com/frida/frida/releases/download/17.16.4/{filename}"
            ));
            run(curl);
        }
        let hash = format!("{:x}", Sha256::digest(fs::read(&archive).unwrap()));
        assert_eq!(
            hash,
            checksum,
            "Frida devkit checksum mismatch; remove {} and retry",
            archive.display()
        );
        let mut tar = Command::new("tar");
        tar.arg("-xf").arg(&archive).arg("-C").arg(&kit);
        run(tar);
    }
    assert!(
        kit.join(library).is_file(),
        "Frida devkit library is missing"
    );
    println!("cargo:rustc-link-search=native={}", kit.display());
    println!("cargo:rustc-link-lib=static=frida-core");
    if os == "windows" {
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:LIBCMT");
        for library in [
            "dnsapi", "iphlpapi", "psapi", "winmm", "ws2_32", "advapi32", "crypt32", "gdi32",
            "kernel32", "ole32", "secur32", "shell32", "shlwapi", "user32", "setupapi",
        ] {
            println!("cargo:rustc-link-lib={library}");
        }
    } else {
        for library in ["pthread", "resolv"] {
            println!("cargo:rustc-link-lib={library}");
        }
        if os == "macos" {
            println!("cargo:rustc-link-lib=bsm");
            for library in ["AppKit", "Security", "IOKit"] {
                println!("cargo:rustc-link-lib=framework={library}");
            }
        }
    }
}

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=native/CMakeLists.txt");
    println!("cargo:rerun-if-changed=hoshidicts/CMakeLists.txt");
    println!("cargo:rerun-if-changed=hoshidicts/include");
    println!("cargo:rerun-if-changed=hoshidicts/src");

    let destination = cmake::Config::new("native")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("HOSHIDICTS_CLI", "OFF")
        .define("HOSHIDICTS_BENCHMARK", "OFF")
        .define("HOSHIDICTS_TESTS", "OFF")
        .build();

    println!(
        "cargo:rustc-link-search=native={}",
        destination.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=hoshidicts");

    let target = env::var("TARGET").expect("Cargo did not set TARGET");
    if target.contains("msvc") {
        println!("cargo:rustc-link-lib=static=zstd_static");
        println!("cargo:rustc-link-lib=static=deflatestatic");
        println!("cargo:rustc-link-lib=static=utf8proc_static");
    } else {
        println!("cargo:rustc-link-lib=static=zstd");
        println!("cargo:rustc-link-lib=static=deflate");
        println!("cargo:rustc-link-lib=static=utf8proc");
    }

    if target.contains("apple") {
        println!("cargo:rustc-link-lib=dylib=c++");
    } else if !target.contains("msvc") {
        println!("cargo:rustc-link-lib=dylib=stdc++");
    }
}

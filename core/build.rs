//! Link against libcodec2 (LGPL-2.1, separate component, dynamically linked).
//!
//! Search order:
//! 1. `CODEC2_LIB_DIR` environment variable, if set.
//! 2. A system `libcodec2.so` in the default linker paths (just `-lcodec2`).
//! 3. A versioned soname (e.g. `libcodec2.so.1.2`) found in a standard
//!    directory: symlinked into OUT_DIR so `-lcodec2` resolves.

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=CODEC2_LIB_DIR");

    // WebAssembly: do not link anything. The codec2_* symbols stay
    // undefined and become imports of the core module; the JS library
    // satisfies them from the separately built codec2.wasm
    // (JS-mediated linking, docs/system-design.md §3).
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        // Keep the undefined codec2_* symbols as wasm imports instead
        // of link errors.
        println!("cargo:rustc-link-arg=--allow-undefined");
        return;
    }

    if let Ok(dir) = env::var("CODEC2_LIB_DIR") {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=codec2");
        return;
    }

    let candidates = ["/usr/lib/x86_64-linux-gnu", "/usr/lib", "/usr/local/lib", "/lib/x86_64-linux-gnu"];
    for dir in candidates {
        if Path::new(dir).join("libcodec2.so").exists() {
            println!("cargo:rustc-link-search=native={dir}");
            println!("cargo:rustc-link-lib=codec2");
            return;
        }
    }
    // No unversioned symlink: find a versioned soname and link via a symlink.
    for dir in candidates {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with("libcodec2.so.") {
                    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("lib");
                    std::fs::create_dir_all(&out).unwrap();
                    let link = out.join("libcodec2.so");
                    if !link.exists() {
                        std::os::unix::fs::symlink(e.path(), &link).unwrap();
                    }
                    println!("cargo:rustc-link-search=native={}", out.display());
                    println!("cargo:rustc-link-lib=codec2");
                    return;
                }
            }
        }
    }
    // Last resort: let the linker try its defaults.
    println!("cargo:rustc-link-lib=codec2");
}

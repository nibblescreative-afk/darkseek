//! Builds the IDL of an Anchor program crate the same way the Anchor CLI does
//! (compiling it with the `idl-build` feature and collecting the printed parts),
//! so the IDL can be produced and checked without installing the CLI.
//!
//! usage: idl-build <program crate dir> [output.json]

use anchor_lang_idl::build::IdlBuilder;
use std::{env, fs, path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(program) = args.first() else {
        eprintln!("usage: idl-build <program crate dir> [output.json]");
        return ExitCode::from(2);
    };
    let path = match fs::canonicalize(program) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("idl-build: {program}: {e}");
            return ExitCode::from(2);
        }
    };
    // anchor-lang-idl 0.1.4 turns a set RUSTUP_TOOLCHAIN into a literal `cargo +{toolchain}`;
    // `cargo run` sets it, so drop it and let rustup pick the toolchain as usual
    env::remove_var("RUSTUP_TOOLCHAIN");
    let idl = match IdlBuilder::new().program_path(PathBuf::from(&path)).skip_lint(true).build() {
        Ok(idl) => idl,
        Err(e) => {
            eprintln!("idl-build: {e:#}");
            return ExitCode::FAILURE;
        }
    };
    let json = serde_json::to_string_pretty(&idl).expect("IDL serializes") + "\n";
    match args.get(1) {
        Some(out) => {
            if let Err(e) = fs::write(out, json) {
                eprintln!("idl-build: {out}: {e}");
                return ExitCode::FAILURE;
            }
        }
        None => print!("{json}"),
    }
    ExitCode::SUCCESS
}

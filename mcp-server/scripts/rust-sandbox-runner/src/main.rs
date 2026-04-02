//! Rust Sandbox Runner — MCP code_mode utility
//! =============================================
//!
//! Executes user-provided JavaScript code in a sandboxed boa_engine runtime.
//! boa_engine is a pure-Rust ECMAScript 2021 interpreter — no external C deps.
//!
//! Sandbox guarantees:
//!   - No filesystem access (no require, no Node.js APIs)
//!   - No network access
//!   - No process/OS access
//!   - DATA global variable injected with input data
//!   - print() and console.log() captured to stdout
//!
//! Contract:
//!   Input:  JavaScript code is read from stdin
//!           DATA is injected from $SANDBOX_DATA environment variable
//!   Output: stdout from print() / console.log() calls
//!   Exit:   0 = success, 1 = runtime/compilation error
//!
//! Usage (called by the Node.js MCP executor):
//!   echo "<user_js_code>" | SANDBOX_DATA="<data>" ./sandbox-runner
//!
//! Build:
//!   cd scripts/rust-sandbox-runner && cargo build --release
//!   Binary at: target/release/sandbox-runner

use boa_engine::{
    js_string, object::ObjectInitializer, Context, JsValue, NativeFunction, Source,
};
use std::cell::RefCell;
use std::env;
use std::io::{self, Read};
use std::process;

// Thread-local storage for captured output — avoids Gc/Trace requirements
thread_local! {
    static STDOUT_LINES: RefCell<Vec<String>> = RefCell::new(Vec::new());
    static STDERR_LINES: RefCell<Vec<String>> = RefCell::new(Vec::new());
}

fn push_stdout(line: String) {
    STDOUT_LINES.with(|v| v.borrow_mut().push(line));
}

fn push_stderr(line: String) {
    STDERR_LINES.with(|v| v.borrow_mut().push(line));
}

fn collect_stdout() -> String {
    STDOUT_LINES.with(|v| v.borrow().join("\n"))
}

fn collect_stderr() -> String {
    STDERR_LINES.with(|v| v.borrow().join("\n"))
}

fn main() {
    let mut code = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut code) {
        eprintln!("[rust-sandbox] Failed to read code from stdin: {e}");
        process::exit(1);
    }
    let code = code.trim().to_string();
    if code.is_empty() {
        eprintln!("[rust-sandbox] No code provided via stdin.");
        process::exit(1);
    }

    let data = env::var("SANDBOX_DATA").unwrap_or_default();

    match run_in_boa(&code, &data) {
        Ok(()) => {
            let stdout = collect_stdout();
            let stderr = collect_stderr();
            if !stdout.is_empty() { print!("{stdout}"); }
            if !stderr.is_empty() { eprint!("{stderr}"); }
            process::exit(0);
        }
        Err(err_msg) => {
            let stdout = collect_stdout();
            let stderr = collect_stderr();
            if !stdout.is_empty() { print!("{stdout}"); }
            if !stderr.is_empty() { eprint!("{stderr}"); }
            eprintln!("{err_msg}");
            process::exit(1);
        }
    }
}

fn run_in_boa(code: &str, data: &str) -> Result<(), String> {
    let mut context = Context::default();

    // Inject DATA global
    context
        .register_global_property(
            js_string!("DATA"),
            JsValue::from(js_string!(data.to_owned())),
            boa_engine::property::Attribute::all(),
        )
        .map_err(|e| format!("[rust-sandbox] Failed to set DATA: {e}"))?;

    // print() → stdout
    let print_fn = NativeFunction::from_fn_ptr(|_this, args, _ctx| {
        let parts: Vec<String> = args.iter().map(|v| v.display().to_string()).collect();
        push_stdout(parts.join(" "));
        Ok(JsValue::undefined())
    });
    context
        .register_global_callable(js_string!("print"), 0, print_fn)
        .map_err(|e| format!("[rust-sandbox] Failed to register print: {e}"))?;

    // console.log / console.error / console.warn
    let log_fn = NativeFunction::from_fn_ptr(|_this, args, _ctx| {
        let parts: Vec<String> = args.iter().map(|v| v.display().to_string()).collect();
        push_stdout(parts.join(" "));
        Ok(JsValue::undefined())
    });
    let error_fn = NativeFunction::from_fn_ptr(|_this, args, _ctx| {
        let parts: Vec<String> = args.iter().map(|v| v.display().to_string()).collect();
        push_stderr(parts.join(" "));
        Ok(JsValue::undefined())
    });
    let warn_fn = NativeFunction::from_fn_ptr(|_this, args, _ctx| {
        let parts: Vec<String> = args.iter().map(|v| v.display().to_string()).collect();
        push_stderr(format!("[warn] {}", parts.join(" ")));
        Ok(JsValue::undefined())
    });

    let console_obj = ObjectInitializer::new(&mut context)
        .function(log_fn, js_string!("log"), 0)
        .function(error_fn, js_string!("error"), 0)
        .function(warn_fn, js_string!("warn"), 0)
        .build();

    context
        .register_global_property(
            js_string!("console"),
            JsValue::Object(console_obj),
            boa_engine::property::Attribute::all(),
        )
        .map_err(|e| format!("[rust-sandbox] Failed to set console: {e}"))?;

    // Execute user code
    let source = Source::from_bytes(code.as_bytes());
    context
        .eval(source)
        .map(|_| ())
        .map_err(|e| format!("[rust-sandbox] {e}"))
}

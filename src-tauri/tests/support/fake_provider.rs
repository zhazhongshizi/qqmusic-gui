use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    process::{self, Command, Stdio},
    thread,
    time::Duration,
};

use serde_json::{json, Value};

const MAX_LINE_BYTES: usize = 1_048_576;

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "fake_provider_failed:{error}");
        process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut scenario = "normal".to_owned();
    let mut marker: Option<PathBuf> = None;
    let mut request_id_arg: Option<String> = None;
    let mut args = env::args_os().skip(1);
    while let Some(argument) = args.next() {
        match argument.to_string_lossy().as_ref() {
            "--scenario" => {
                scenario = args
                    .next()
                    .ok_or("missing scenario")?
                    .to_string_lossy()
                    .into_owned();
            }
            "--marker" => marker = Some(PathBuf::from(args.next().ok_or("missing marker")?)),
            "--request-id" => {
                request_id_arg = Some(
                    args.next()
                        .ok_or("missing request id")?
                        .to_string_lossy()
                        .into_owned(),
                )
            }
            _ => return Err("unknown argument".to_owned()),
        }
    }

    if scenario == "emit-late" {
        thread::sleep(Duration::from_millis(300));
        return write_success_for_id(request_id_arg.as_deref().ok_or("request id required")?);
    }

    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let handshake = next_request(&mut lines)?;
    let handshake_id = request_id(&handshake)?;
    if handshake["method"] != "system.handshake" {
        return Err("handshake required".to_owned());
    }
    if scenario == "version-mismatch" {
        write_json(&json!({
            "v": 2,
            "id": handshake_id,
            "ok": true,
            "result": {},
            "warnings": []
        }))?;
        return Ok(());
    }
    write_handshake(handshake_id)?;

    if scenario == "out-of-order" {
        let first = next_request(&mut lines)?;
        let second = next_request(&mut lines)?;
        write_success(&second)?;
        write_success(&first)?;
        return Ok(());
    }

    let mut request_number = 0_u64;
    for line in lines {
        let line = line.map_err(|_| "stdin read")?;
        let request: Value = serde_json::from_str(&line).map_err(|_| "invalid request")?;
        request_number += 1;
        match scenario.as_str() {
            "unknown" => {
                write_json(&json!({
                    "v": 1,
                    "id": "never-requested",
                    "ok": true,
                    "result": {},
                    "warnings": []
                }))?;
            }
            "duplicate" => {
                write_success(&request)?;
                write_success(&request)?;
            }
            "timeout" => thread::sleep(Duration::from_secs(10)),
            "timeout-once" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                if !marker.exists() {
                    fs::write(marker, b"timed-out").map_err(|_| "marker write")?;
                    thread::sleep(Duration::from_secs(10));
                } else {
                    write_success(&request)?;
                }
            }
            "timeout-two-independent" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                let completed_timeouts = read_counter(marker)?;
                if request_number > completed_timeouts {
                    write_counter(marker, completed_timeouts + 1)?;
                    thread::sleep(Duration::from_secs(10));
                } else {
                    write_success(&request)?;
                }
            }
            "delayed" => {
                thread::sleep(Duration::from_millis(300));
                write_success(&request)?;
            }
            "invalid-utf8" => {
                io::stdout()
                    .write_all(b"{\"v\":1,\"id\":\"")
                    .map_err(|_| "stdout")?;
                io::stdout()
                    .write_all(&[0xff, b'\n'])
                    .map_err(|_| "stdout")?;
                io::stdout().flush().map_err(|_| "stdout")?;
            }
            "oversized" => {
                io::stdout()
                    .write_all(&vec![b'x'; MAX_LINE_BYTES + 1])
                    .map_err(|_| "stdout")?;
                io::stdout().write_all(b"\n").map_err(|_| "stdout")?;
                io::stdout().flush().map_err(|_| "stdout")?;
            }
            "event" => {
                write_json(&json!({"v":1,"event":"fixture.ready","payload":{"safe":true}}))?;
                write_success(&request)?;
            }
            "stderr-flood" => {
                let chunk = [b'x'; 8192];
                for _ in 0..256 {
                    io::stderr().write_all(&chunk).map_err(|_| "stderr")?;
                }
                io::stderr().flush().map_err(|_| "stderr")?;
                write_success(&request)?;
            }
            "crash-once" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                if !marker.exists() {
                    fs::write(marker, b"crashed").map_err(|_| "marker write")?;
                    process::exit(23);
                }
                write_success(&request)?;
            }
            "crash-after-recovery-once" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                if request_number == 2 && !marker.exists() {
                    fs::write(marker, b"crashed").map_err(|_| "marker write")?;
                    process::exit(25);
                }
                write_success(&request)?;
            }
            "crash-during-recovery-once" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                let stage = fs::read_to_string(marker).unwrap_or_default();
                let id = request_id(&request)?;
                if id.starts_with("recovery-") && stage == "user-crashed" {
                    fs::write(marker, b"recovery-crashed").map_err(|_| "marker write")?;
                    process::exit(26);
                }
                if !id.starts_with("recovery-") && stage.is_empty() {
                    fs::write(marker, b"user-crashed").map_err(|_| "marker write")?;
                    process::exit(25);
                }
                write_success(&request)?;
            }
            "late-old-generation-once" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                if !marker.exists() {
                    fs::write(marker, b"spawned").map_err(|_| "marker write")?;
                    Command::new(env::current_exe().map_err(|_| "current exe")?)
                        .args([
                            "--scenario",
                            "emit-late",
                            "--request-id",
                            request_id(&request)?,
                        ])
                        .stdin(Stdio::null())
                        .stdout(Stdio::inherit())
                        .stderr(Stdio::null())
                        .spawn()
                        .map_err(|_| "late emitter spawn")?;
                    process::exit(27);
                }
                write_success(&request)?;
            }
            "write-timeout-count" => {
                let marker = marker.as_ref().ok_or("marker required")?;
                let count = read_counter(marker)?;
                write_counter(marker, count + 1)?;
                thread::sleep(Duration::from_secs(10));
            }
            "write-crash" => process::exit(24),
            _ => write_success(&request)?,
        }
    }
    Ok(())
}

fn next_request(
    lines: &mut impl Iterator<Item = Result<String, io::Error>>,
) -> Result<Value, String> {
    let line = lines
        .next()
        .ok_or("stdin closed")?
        .map_err(|_| "stdin read")?;
    serde_json::from_str(&line).map_err(|_| "invalid request".to_owned())
}

fn request_id(request: &Value) -> Result<&str, String> {
    request["id"]
        .as_str()
        .ok_or_else(|| "missing id".to_owned())
}

fn write_handshake(id: &str) -> Result<(), String> {
    write_json(&json!({
        "v": 1,
        "id": id,
        "ok": true,
        "result": {
            "provider": {"name":"qqmusic-provider","version":"0.1.0","mode":"fixture"},
            "protocol": {"version":1,"maxLineBytes":MAX_LINE_BYTES},
            "capabilities": {
                "authMethods": [],
                "searchTypes": ["songs"],
                "recommendModules": [],
                "playlistWrites": [],
                "playlistExtensions": {"rename":false,"description":false},
                "lyricVariants": [],
                "qualityCandidates": []
            },
            "implementedMethods": ["system.handshake","system.ping","search.songs"],
            "upstream": {"name":"fixture","requiredVersion":"0","installedVersion":"0"}
        },
        "warnings": []
    }))
}

fn write_success(request: &Value) -> Result<(), String> {
    let id = request_id(request)?;
    let method = request["method"].as_str().ok_or("missing method")?;
    let result = match method {
        "system.ping" => json!({"pong":true}),
        "search.songs" => json!({
            "echo": request["params"]["keyword"].as_str().unwrap_or_default()
        }),
        _ => json!({"accepted":true}),
    };
    write_json(&json!({"v":1,"id":id,"ok":true,"result":result,"warnings":[]}))
}

fn write_success_for_id(id: &str) -> Result<(), String> {
    write_json(&json!({"v":1,"id":id,"ok":true,"result":{"pong":true},"warnings":[]}))
}

fn read_counter(path: &PathBuf) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    fs::read_to_string(path)
        .map_err(|_| "marker read".to_owned())?
        .parse()
        .map_err(|_| "marker parse".to_owned())
}

fn write_counter(path: &PathBuf, value: u64) -> Result<(), String> {
    fs::write(path, value.to_string()).map_err(|_| "marker write".to_owned())
}

fn write_json(value: &Value) -> Result<(), String> {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, value).map_err(|_| "serialize")?;
    stdout.write_all(b"\n").map_err(|_| "stdout")?;
    stdout.flush().map_err(|_| "stdout".to_owned())
}

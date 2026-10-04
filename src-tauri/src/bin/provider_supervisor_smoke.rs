use std::{env, path::PathBuf, process, time::Duration};

use qqmusic_gui_lib::provider::{
    ProviderReply, ProviderRequest, ProviderSupervisor, SupervisorConfig, VerifiedProviderBundle,
};
use serde_json::{Map, Value};

fn main() {
    if let Err(code) = run() {
        eprintln!("provider_supervisor_smoke_failed:{code}");
        process::exit(2);
    }
}

fn run() -> Result<(), &'static str> {
    let mut args = env::args_os().skip(1);
    let bundle_root = PathBuf::from(args.next().ok_or("missing_bundle_root")?);
    let live_search = match args.next() {
        None => false,
        Some(flag) if flag == "--live-search" => true,
        Some(_) => return Err("unexpected_argument"),
    };
    if args.next().is_some() {
        return Err("unexpected_argument");
    }

    let bundle = VerifiedProviderBundle::verify(bundle_root).map_err(|_| "bundle_invalid")?;
    let launch = bundle.launch().map_err(|_| "launch_invalid")?;
    let supervisor = ProviderSupervisor::start(
        launch,
        SupervisorConfig {
            handshake_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(10),
            restart_backoff: Duration::from_millis(100),
            max_restarts: 1,
        },
    )
    .map_err(|_| "supervisor_start_failed")?;

    let ping = success(supervisor.request(ProviderRequest::read_only("system.ping", Map::new())))?;
    if ping.get("pong") != Some(&Value::Bool(true)) {
        return Err("ping_contract_failed");
    }

    if live_search {
        let search = success(supervisor.request(ProviderRequest::read_only(
            "search.songs",
            Map::from_iter([
                ("keyword".to_owned(), Value::String("晴天".to_owned())),
                ("pageSize".to_owned(), Value::Number(3.into())),
            ]),
        )))?;
        let item_count = search
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::len)
            .ok_or("search_contract_failed")?;
        if item_count == 0 || search.contains_key("source") {
            return Err("search_contract_failed");
        }
        println!("provider_supervisor_smoke_ok ping=true live_search_items={item_count}");
    } else {
        println!("provider_supervisor_smoke_ok ping=true");
    }
    Ok(())
}

fn success(
    reply: Result<ProviderReply, qqmusic_gui_lib::provider::ProviderError>,
) -> Result<Map<String, Value>, &'static str> {
    match reply.map_err(|_| "provider_request_failed")? {
        ProviderReply::Success { result, warnings } if warnings.is_empty() => Ok(result),
        ProviderReply::Success { .. } => Err("unexpected_warning"),
        ProviderReply::Failure { .. } => Err("provider_failure"),
    }
}

#[cfg(not(windows))]
compile_error!("native-player-smoke is Windows-only");

use std::{
    env,
    path::PathBuf,
    process, thread,
    time::{Duration, Instant},
};

use qqmusic_gui_lib::player::{
    local_media_file_for_smoke, NativePlayerEvent, PlayerCommand, PlayerEngine, RemoteMediaUrl,
    SeekPositionMs, SmtcMetadata, TrackSummary, VolumeLevel, WindowsMediaPlayerEngine,
};

fn main() {
    if let Err(code) = run() {
        eprintln!("native_player_smoke_failed:{code}");
        process::exit(2);
    }
}

fn run() -> Result<(), &'static str> {
    let mut args = env::args().skip(1);
    let format = args.next().ok_or("missing_format")?;
    let media = args.next().ok_or("missing_media")?;
    if args.next().is_some() {
        return Err("unexpected_argument");
    }

    let mut engine = WindowsMediaPlayerEngine::new().map_err(|_| "engine_unavailable")?;
    engine
        .handle(PlayerCommand::SetMuted { muted: true })
        .map_err(|_| "mute_failed")?;
    engine
        .handle(PlayerCommand::SetVolume {
            volume: VolumeLevel::new(0.25).map_err(|_| "volume_invalid")?,
        })
        .map_err(|_| "volume_failed")?;
    let track = TrackSummary {
        source: format
            .starts_with("qq-mv")
            .then_some(qqmusic_gui_lib::player::TrackSource::QqMv),
        id: format!("spike-{format}"),
        title: "Native playback spike".to_owned(),
        artist: "Public test media".to_owned(),
    };
    let load = if format.starts_with("local-") {
        PlayerCommand::LoadLocal {
            file: local_media_file_for_smoke(PathBuf::from(media))
                .map_err(|_| "invalid_local_file")?,
            track,
            smtc_metadata: SmtcMetadata::default(),
        }
    } else {
        PlayerCommand::LoadRemote {
            url: RemoteMediaUrl::parse(media).map_err(|_| "invalid_url")?,
            track,
            smtc_metadata: SmtcMetadata::default(),
        }
    };
    engine.handle(load).map_err(|_| "load_failed")?;

    let immediate_play = format.ends_with("-immediate");
    if immediate_play {
        engine
            .handle(PlayerCommand::Play)
            .map_err(|_| "play_failed")?;
        wait_for_open(&engine, Duration::from_secs(20))?;
    } else {
        wait_for_open(&engine, Duration::from_secs(20))?;
        engine
            .handle(PlayerCommand::Play)
            .map_err(|_| "play_failed")?;
    }
    thread::sleep(Duration::from_millis(750));
    engine
        .handle(PlayerCommand::Pause)
        .map_err(|_| "pause_failed")?;
    engine
        .handle(PlayerCommand::Seek {
            position: SeekPositionMs::new(250).map_err(|_| "seek_invalid")?,
        })
        .map_err(|_| "seek_failed")?;

    let snapshot = engine.snapshot();
    let snapshot_json = serde_json::to_value(snapshot).map_err(|_| "snapshot_failed")?;
    if snapshot_json.get("currentTrack").is_none() || snapshot_json.get("url").is_some() {
        return Err("snapshot_boundary_failed");
    }
    if format.starts_with("qq-mv") && snapshot_json["currentTrack"]["source"] != "qq-mv" {
        return Err("mv_source_marker_failed");
    }
    engine
        .handle(PlayerCommand::Stop)
        .map_err(|_| "stop_failed")?;
    println!("native_player_smoke_ok format={format} muted=true");
    Ok(())
}

fn wait_for_open(engine: &WindowsMediaPlayerEngine, timeout: Duration) -> Result<(), &'static str> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match engine.try_event() {
            Some(NativePlayerEvent::Opened { .. }) => return Ok(()),
            Some(NativePlayerEvent::Failed { .. }) => return Err("media_failed"),
            Some(NativePlayerEvent::Ended { .. })
            | Some(NativePlayerEvent::TransportPlay)
            | Some(NativePlayerEvent::TransportPause)
            | Some(NativePlayerEvent::TransportStop)
            | Some(NativePlayerEvent::TransportNext)
            | Some(NativePlayerEvent::TransportPrevious)
            | None => {
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
    Err("open_timeout")
}

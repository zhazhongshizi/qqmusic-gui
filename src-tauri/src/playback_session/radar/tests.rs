use super::*;
use crate::provider::{ProviderError, ProviderReply, ProviderRequest, ProviderRequestPort};
use std::sync::{atomic::AtomicUsize, mpsc};

struct Feed {
    calls: AtomicUsize,
    batch: usize,
    repeated: bool,
    fail_at: usize,
    gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}

impl Feed {
    fn new(batch: usize) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            batch,
            repeated: false,
            fail_at: 0,
            gate: Mutex::new(None),
        })
    }
    fn catalog(self: &Arc<Self>) -> Arc<CatalogService> {
        Arc::new(CatalogService::new(self.clone()))
    }
}

impl ProviderRequestPort for Feed {
    fn request(&self, _: ProviderRequest) -> Result<ProviderReply, ProviderError> {
        let page = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some((entered, release)) = self.gate.lock().unwrap().take() {
            entered.send(()).unwrap();
            release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        if page == self.fail_at {
            return Ok(ProviderReply::Failure {
                code: "network_unavailable".into(),
                retryable: false,
            });
        }
        let from = if self.repeated {
            0
        } else {
            (page - 1) * self.batch
        };
        let items: Vec<_> = (from..from + self.batch).map(|index| serde_json::json!({
            "id": format!("song-{}", index + 1), "title": "Track", "subtitle": "",
            "artists": [{"id":"artist","name":"Artist"}], "album":{"id":"album","title":"Album","publishDate":""},
            "durationMs":180000, "qualityCandidates":[
                {"quality":"flac","available":false,"requiresSubscription":false},
                {"quality":"320k","available":true,"requiresSubscription":false},
                {"quality":"128k","available":true,"requiresSubscription":false}
            ], "availability":{"status":"unknown","requiresSubscription":false}
        })).collect();
        Ok(ProviderReply::Success {
            result: serde_json::json!({"items":items,"page":page,"hasMore":true})
                .as_object()
                .unwrap()
                .clone(),
            warnings: vec![],
        })
    }
}

fn playing_at(session: &PlaybackSession, index: usize) {
    session.play_index(index, PlaybackQuality::Auto).unwrap();
    session.playback.play().unwrap();
}

#[test]
fn starts_with_ten_and_refills_five_at_fifth_tenth_and_fifteenth_tracks() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let feed = Feed::new(10);
    let snapshot = test.session.start_radar(feed.catalog()).unwrap();
    assert_eq!(snapshot.queue.items.len(), 10);
    assert_eq!(snapshot.mode, PlaybackMode::Sequence);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 1);
    playing_at(&test.session, 3);
    assert!(test.session.prepare_radar_refill().is_none());
    for (index, expected, calls) in [(4, 15, 2), (9, 20, 2), (14, 25, 3)] {
        playing_at(&test.session, index);
        let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
        assert!(test.session.prepare_radar_refill().is_none());
        test.session.refill_radar(epoch, reader, ids);
        let queue = test.session.queue.snapshot();
        assert_eq!(queue.items.len(), expected);
        assert_eq!(queue.selected_index, Some(index));
        assert_eq!(feed.calls.load(Ordering::SeqCst), calls);
        assert!(test.session.prepare_radar_refill().is_none());
    }
}

#[test]
fn keeps_upstream_overflow_without_fetching_on_each_refill() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let feed = Feed::new(20);
    test.session.start_radar(feed.catalog()).unwrap();
    for index in [4, 9] {
        playing_at(&test.session, index);
        let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
        test.session.refill_radar(epoch, reader, ids);
    }
    assert_eq!(test.session.queue.snapshot().items.len(), 20);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn pause_suspends_reads_and_resume_can_refill_the_same_radar_queue() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let feed = Feed::new(10);
    test.session.start_radar(feed.catalog()).unwrap();
    playing_at(&test.session, 4);
    let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
    test.session.pause().unwrap();
    test.session.refill_radar(epoch, reader, ids);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 1);
    assert_eq!(test.session.queue.snapshot().items.len(), 10);
    assert!(test.session.prepare_radar_refill().is_none());
    test.session.play().unwrap();
    let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
    test.session.refill_radar(epoch, reader, ids);
    assert_eq!(test.session.queue.snapshot().items.len(), 15);
}

#[test]
fn late_refill_cannot_append_after_pause_stop_or_queue_replacement() {
    for action in ["pause", "stop", "replace"] {
        let (test, _) = crate::playback_session::tests::failure_session(&[]);
        let feed = Feed::new(10);
        test.session.start_radar(feed.catalog()).unwrap();
        playing_at(&test.session, 4);
        let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *feed.gate.lock().unwrap() = Some((entered_tx, release_rx));
        thread::scope(|scope| {
            let session = &test.session;
            let worker = scope.spawn(move || session.refill_radar(epoch, reader, ids));
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            match action {
                "pause" => {
                    session.pause().unwrap();
                }
                "stop" => {
                    session.stop().unwrap();
                }
                _ => {
                    session.replace_queue(vec![]).unwrap();
                }
            }
            release_tx.send(()).unwrap();
            worker.join().unwrap();
        });
        assert_eq!(feed.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            test.session.queue.snapshot().items.len(),
            if action == "replace" { 0 } else { 10 }
        );
        assert!(test.session.prepare_radar_refill().is_none());
    }
}

#[test]
fn queue_edits_and_stale_initial_reads_do_not_overwrite_new_playback() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let feed = Feed::new(10);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *feed.gate.lock().unwrap() = Some((entered_tx, release_rx));
    thread::scope(|scope| {
        let session = &test.session;
        let catalog = feed.catalog();
        let worker = scope.spawn(move || session.start_radar(catalog));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        session.replace_queue(vec![]).unwrap();
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
    });
    assert!(test.session.queue.snapshot().items.is_empty());
    test.session.start_radar(feed.catalog()).unwrap();
    playing_at(&test.session, 4);
    let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
    // Direct queue edits can bypass the session operation lock. The append must
    // still check ownership under the queue's own write lock.
    test.session.queue.replace(vec![]).unwrap();
    test.session.refill_radar(epoch, reader, ids);
    assert!(test.session.queue.snapshot().items.is_empty());
    assert!(test.session.radar.lock().unwrap().is_none());
}

#[test]
fn repeated_and_empty_batches_stop_without_scanning_to_page_one_hundred() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let mut feed = Feed::new(10);
    Arc::get_mut(&mut feed).unwrap().repeated = true;
    test.session.start_radar(feed.catalog()).unwrap();
    playing_at(&test.session, 4);
    let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
    test.session.refill_radar(epoch, reader, ids);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 2);
    assert_eq!(test.session.queue.snapshot().items.len(), 10);
    assert!(test.session.prepare_radar_refill().is_none());
    let empty = Feed::new(0);
    let before = test.session.queue.snapshot();
    assert!(test.session.start_radar(empty.catalog()).is_err());
    assert_eq!(empty.calls.load(Ordering::SeqCst), 1);
    assert_eq!(test.session.queue.snapshot(), before);
}

#[test]
fn refill_failure_keeps_playing_the_existing_queue_and_stops_reading() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let mut feed = Feed::new(10);
    Arc::get_mut(&mut feed).unwrap().fail_at = 2;
    test.session.start_radar(feed.catalog()).unwrap();
    playing_at(&test.session, 4);
    let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
    test.session.refill_radar(epoch, reader, ids);
    assert_eq!(test.session.queue.snapshot().items.len(), 10);
    assert_eq!(test.session.playback.snapshot().state, PlayerState::Playing);
    assert!(test.session.prepare_radar_refill().is_none());
}

#[test]
fn short_upstream_batches_still_fill_ten_then_five_without_exhausting_the_feed() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let feed = Feed::new(2);
    test.session.start_radar(feed.catalog()).unwrap();
    assert_eq!(test.session.queue.snapshot().items.len(), 10);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 5);
    playing_at(&test.session, 4);
    let (epoch, reader, ids) = test.session.prepare_radar_refill().unwrap();
    test.session.refill_radar(epoch, reader, ids);
    assert_eq!(test.session.queue.snapshot().items.len(), 15);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 8);
}

#[test]
fn old_refill_cannot_clear_a_new_sessions_pending_flag_even_with_identical_song_ids() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    test.session.start_radar(Feed::new(10).catalog()).unwrap();
    playing_at(&test.session, 4);
    let old = test.session.prepare_radar_refill().unwrap();
    let feed = Feed::new(10);
    test.session.start_radar(feed.catalog()).unwrap();
    playing_at(&test.session, 4);
    let new = test.session.prepare_radar_refill().unwrap();
    test.session.refill_radar(old.0, old.1, old.2);
    assert!(test.session.prepare_radar_refill().is_none());
    assert!(
        test.session
            .radar
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .in_flight
    );
    test.session.refill_radar(new.0, new.1, new.2);
    assert_eq!(test.session.queue.snapshot().items.len(), 15);
}

#[test]
fn pausing_during_initial_fetch_preserves_the_old_queue() {
    let (test, _) = crate::playback_session::tests::failure_session(&[]);
    let feed = Feed::new(10);
    let before = test.session.queue.snapshot();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *feed.gate.lock().unwrap() = Some((entered_tx, release_rx));
    thread::scope(|scope| {
        let session = &test.session;
        let catalog = feed.catalog();
        let worker = scope.spawn(move || session.start_radar(catalog));
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        session.pause().unwrap();
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
    });
    assert_eq!(test.session.queue.snapshot(), before);
    assert!(test.session.radar.lock().unwrap().is_none());
}

#[test]
fn background_worker_refills_after_fifth_track_without_the_discovery_view() {
    let (mut test, _) = crate::playback_session::tests::failure_session(&[]);
    let dummy = PlaybackSession::new(test.session.queue.clone(), test.session.playback.clone());
    let session = Arc::new(std::mem::replace(&mut test.session, dummy));
    let feed = Feed::new(10);
    session.start_radar(feed.catalog()).unwrap();
    playing_at(&session, 4);
    PlaybackSession::start_auto_advance_worker(&session);
    let until = Instant::now() + Duration::from_secs(5);
    while session.queue.snapshot().items.len() != 15 && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    session.auto_worker_stop.store(true, Ordering::Release);
    assert_eq!(session.queue.snapshot().items.len(), 15);
    assert_eq!(feed.calls.load(Ordering::SeqCst), 2);
}

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

interface InvokeResult {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
}

async function invokeTauri(command: string, payload?: Record<string, unknown>): Promise<InvokeResult> {
  return browser.executeAsync(
    (name: string, args: Record<string, unknown> | undefined, done) => {
      const tauri = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string, payload?: object) => Promise<unknown> } };
      }).__TAURI__;
      const invoke = tauri?.core?.invoke;
      if (!invoke) {
        done({ ok: false, error: { code: "tauri_global_missing" } });
        return;
      }
      void invoke(name, args).then(
        (result: unknown) => done({ ok: true, result }),
        (error: unknown) => {
          const value = error as { code?: unknown; operation?: unknown; retryable?: unknown };
          done({
            ok: false,
            error: {
              code: typeof value?.code === "string" ? value.code : "unknown",
              operation: typeof value?.operation === "string" ? value.operation : "unknown",
              retryable: value?.retryable === true,
            },
          });
        },
      );
    },
    command,
    payload,
  ) as Promise<InvokeResult>;
}

async function invokePageSummary(payload: Record<string, unknown>) {
  const serialized = await browser.executeAsync(
    (args: Record<string, unknown>, done) => {
      const invoke = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string, payload?: object) => Promise<unknown> } };
      }).__TAURI__?.core?.invoke;
      if (!invoke) {
        done(JSON.stringify({ ok: false, code: "tauri_global_missing" }));
        return;
      }
      void invoke("catalog_playlist_songs", args).then(
        (value: unknown) => {
          const page = value as { items?: unknown[]; warningCount?: unknown };
          done(JSON.stringify({
            ok: true,
            itemCount: page.items?.length ?? -1,
            warningCount: page.warningCount,
          }));
        },
        (error: unknown) => {
          const value = error as { code?: unknown; operation?: unknown; retryable?: unknown };
          done(JSON.stringify({
            ok: false,
            error: {
              code: typeof value?.code === "string" ? value.code : "unknown",
              operation: typeof value?.operation === "string" ? value.operation : "unknown",
              retryable: value?.retryable === true,
            },
          }));
        },
      );
    },
    payload,
  ) as string;
  return JSON.parse(serialized) as {
    ok: boolean;
    itemCount?: number;
    warningCount?: unknown;
    error?: unknown;
    code?: string;
  };
}

async function invokeCollectionSummary(command: string, payload: Record<string, unknown>) {
  const serialized = await browser.executeAsync(
    (name: string, args: Record<string, unknown>, done) => {
      const invoke = (globalThis as typeof globalThis & {
        __TAURI__?: { core?: { invoke?: (command: string, payload?: object) => Promise<unknown> } };
      }).__TAURI__?.core?.invoke;
      if (!invoke) {
        done(JSON.stringify({ ok: false, code: "tauri_global_missing" }));
        return;
      }
      void invoke(name, args).then(
        (value: unknown) => {
          const page = value as { items?: unknown[]; total?: unknown; warningCount?: unknown };
          done(JSON.stringify({
            ok: true,
            itemCount: page.items?.length ?? -1,
            total: page.total,
            warningCount: page.warningCount,
          }));
        },
        (error: unknown) => {
          const value = error as { code?: unknown; operation?: unknown; retryable?: unknown };
          done(JSON.stringify({
            ok: false,
            error: {
              code: typeof value?.code === "string" ? value.code : "unknown",
              operation: typeof value?.operation === "string" ? value.operation : "unknown",
              retryable: value?.retryable === true,
            },
          }));
        },
      );
    },
    command,
    payload,
  ) as string;
  return JSON.parse(serialized) as {
    ok: boolean;
    itemCount?: number;
    total?: number;
    warningCount?: number;
    error?: unknown;
  };
}

describe("QQ Music GUI live playlist and playback acceptance", () => {
  it("opens an authenticated playlist and plays two known QQ Music tracks", async function () {
    this.timeout(120_000);

    const recovered = await invokeTauri("auth_recover");
    expect(recovered).toMatchObject({
      ok: true,
      result: { state: "authenticated" },
    });

    const liked = await invokeCollectionSummary("library_liked_songs", {
      page: 1,
      pageSize: 20,
      generation: 1,
    });
    if (!liked.ok) throw new Error(`library_liked_songs_failed:${JSON.stringify(liked.error)}`);
    expect(liked.itemCount ?? 0).toBeGreaterThan(0);

    const favorite = await invokeCollectionSummary("library_playlists", {
      kind: "favorite",
      page: 1,
      pageSize: 20,
    });
    if (!favorite.ok) throw new Error(`favorite_playlists_failed:${JSON.stringify(favorite.error)}`);
    expect(favorite.itemCount).toBeGreaterThanOrEqual(0);

    const playlists = await invokeTauri("library_playlists", {
      kind: "created",
      page: 1,
      pageSize: 20,
    });
    if (!playlists.ok) throw new Error(`library_playlists_failed:${JSON.stringify(playlists.error)}`);
    const playlistItems = (playlists.result as {
      items?: Array<{ id?: unknown; editableId?: unknown }>;
    }).items;
    const playlistId = playlistItems?.[0]?.id;
    const editableId = playlistItems?.[0]?.editableId;
    if (typeof playlistId !== "string") throw new Error("library_playlists_missing_id");

    const playlistDetail = await invokePageSummary({
      playlistId,
      ...(typeof editableId === "string" ? { editableId } : {}),
      page: 1,
      pageSize: 20,
      generation: 1,
    });
    if (!playlistDetail.ok) {
      throw new Error(`catalog_playlist_songs_failed:${JSON.stringify(playlistDetail.error)}`);
    }
    expect(playlistDetail.itemCount ?? 0).toBeGreaterThan(0);

    await $('button*=曲库').click();
    await $('button=喜欢').click();
    const firstLikedTrack = await $(".catalog-table tbody tr:first-child .catalog-table__title strong");
    await firstLikedTrack.waitForDisplayed({ timeout: 30_000 });
    expect((await firstLikedTrack.getText()).trim().length).toBeGreaterThan(0);

    await $('button=歌单').click();

    const firstPlaylist = await $('button=打开歌单');
    await firstPlaylist.waitForDisplayed({ timeout: 30_000 });
    const playlistTitle = (await $(".playlist-card h3").getText()).trim();
    await firstPlaylist.click();

    const back = await $('button*=返回全部歌单');
    await back.waitForDisplayed({ timeout: 30_000 });
    await browser.pause(3_000);
    const paneText = await $(".catalog-pane").getText();
    if (paneText.includes("歌单暂时无法打开") || paneText.includes("这个歌单还没有歌曲")) {
      throw new Error(`playlist_ui_state:${paneText}`);
    }
    const firstPlaylistTrack = await $(".playlist-detail__table tbody tr:first-child .catalog-table__title strong");
    await firstPlaylistTrack.waitForDisplayed({ timeout: 30_000 });
    const firstPlaylistTrackTitle = (await firstPlaylistTrack.getText()).trim();
    expect(playlistTitle.length).toBeGreaterThan(0);
    expect(firstPlaylistTrackTitle.length).toBeGreaterThan(0);
    expect(await $(".catalog-empty[role=alert]").isExisting()).toBe(false);

    const evidenceRoot = resolve("output", "wdio");
    await mkdir(evidenceRoot, { recursive: true });
    await browser.saveScreenshot(resolve(evidenceRoot, "live-library-recovered.png"));
    await browser.saveScreenshot(resolve(evidenceRoot, "live-playlist-detail.png"));

    const muted = await invokeTauri("player_set_muted", { muted: true });
    expect(muted.ok).toBe(true);

    const tracks = [
      { id: "000IamLF2r8CTw", title: "酸橙色信笺", artist: "塞壬唱片-MSR / Dazbee / *Luna" },
      { id: "001Np5eS18za71", title: "连烦恼也融入天空", artist: "QQ Music" },
    ] as const;

    for (const track of tracks) {
      const queued = await invokeTauri("queue_enqueue", {
        item: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: "",
          durationMs: 0,
        },
      });
      expect(queued.ok).toBe(true);
      const queue = queued.result as { items?: Array<{ id?: unknown }> };
      const index = queue.items?.findIndex((item) => item.id === track.id) ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      const loaded = await invokeTauri("queue_play", {
        index,
        preferredQuality: "128k",
      });
      expect(loaded.ok).toBe(true);
      expect(loaded.result).toMatchObject({
        playback: {
          quality: "128k",
          player: { currentTrack: { id: track.id } },
        },
      });
      expect(JSON.stringify(loaded)).not.toContain("http");
      expect(JSON.stringify(loaded)).not.toContain("cookie");

      await browser.waitUntil(async () => {
        const snapshot = await invokeTauri("player_snapshot");
        return snapshot.ok
          && (snapshot.result as { state?: unknown; currentTrack?: { id?: unknown } }).state === "playing"
          && (snapshot.result as { currentTrack?: { id?: unknown } }).currentTrack?.id === track.id;
      }, {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: `native_player_did_not_open:${track.id}`,
      });

      const paused = await invokeTauri("player_pause");
      expect(paused).toMatchObject({ ok: true, result: { currentTrack: { id: track.id } } });
      await browser.waitUntil(async () => {
        const snapshot = await invokeTauri("player_snapshot");
        return snapshot.ok
          && (snapshot.result as { state?: unknown }).state === "paused";
      }, { timeout: 10_000, interval: 200, timeoutMsg: `native_player_did_not_pause:${track.id}` });

      const resumed = await invokeTauri("player_play");
      expect(resumed).toMatchObject({ ok: true, result: { currentTrack: { id: track.id } } });
      await browser.waitUntil(async () => {
        const snapshot = await invokeTauri("player_snapshot");
        return snapshot.ok
          && (snapshot.result as { state?: unknown }).state === "playing";
      }, { timeout: 10_000, interval: 200, timeoutMsg: `native_player_did_not_resume:${track.id}` });

      const stopped = await invokeTauri("player_stop");
      expect(stopped.ok).toBe(true);
    }

    await browser.saveScreenshot(resolve(evidenceRoot, "live-playback-accepted.png"));
  });

  it("soaks authenticated read paths while a local liked-song queue plays", async function () {
    const durationMs = Number(process.env.QQ_GUI_SOAK_DURATION_MS ?? 5 * 60_000);
    const faultAfterMs = Number(process.env.QQ_GUI_SOAK_FAULT_AFTER_MS ?? Math.floor(durationMs / 2));
    this.timeout(durationMs + 120_000);

    const recovered = await invokeTauri("auth_recover");
    if (!recovered.ok || (recovered.result as { state?: unknown })?.state !== "authenticated") {
      throw new Error("soak_requires_authenticated_account");
    }
    const counters = { cycles: 0, liked: 0, created: 0, favorite: 0, search: 0, queued: 0, plays: 0 };

    const likedPage = await invokeTauri("library_liked_songs", {
      page: 1,
      pageSize: 20,
      generation: 1,
    });
    if (!likedPage.ok) throw new Error("soak_liked_seed_failed");
    counters.liked += 1;
    const tracks = (likedPage.result as {
      items?: Array<{
        id?: unknown;
        mediaMid?: unknown;
        title?: unknown;
        artist?: unknown;
        album?: unknown;
        durationMs?: unknown;
      }>;
    })?.items?.filter((track) =>
      typeof track.id === "string"
      && typeof track.title === "string"
      && typeof track.artist === "string"
      && typeof track.album === "string"
      && typeof track.durationMs === "number"
    ).slice(0, 8) ?? [];
    if (tracks.length === 0) throw new Error("soak_liked_seed_empty");

    let firstQueuedIndex = -1;
    for (const track of tracks) {
      const queued = await invokeTauri("queue_enqueue", {
        item: {
          id: track.id,
          ...(typeof track.mediaMid === "string" ? { mediaMid: track.mediaMid } : {}),
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationMs: track.durationMs,
        },
      });
      if (!queued.ok) throw new Error("soak_queue_seed_failed");
      const queue = queued.result as { items?: Array<{ id?: unknown }> };
      const index = queue.items?.findIndex((item) => item.id === track.id) ?? -1;
      if (index < 0) throw new Error("soak_queue_seed_item_missing");
      if (firstQueuedIndex < 0) firstQueuedIndex = index;
      counters.queued += 1;
    }

    const loaded = await invokeTauri("queue_play", {
      index: firstQueuedIndex,
      preferredQuality: "128k",
    });
    if (!loaded.ok) throw new Error("soak_playback_seed_failed");
    counters.plays = 1;

    const started = Date.now();
    let faultRequested = false;
    while (Date.now() - started < durationMs) {
      const generation = counters.cycles + 1;
      const liked = await invokeCollectionSummary("library_liked_songs", {
        page: 1, pageSize: 20, generation,
      });
      if (!liked.ok) throw new Error("soak_liked_read_failed");
      counters.liked += 1;

      for (const kind of ["created", "favorite"] as const) {
        const playlists = await invokeTauri("library_playlists", { kind, page: 1, pageSize: 20 });
        if (!playlists.ok) throw new Error(`soak_${kind}_read_failed`);
        counters[kind] += 1;
      }
      const searched = await invokeCollectionSummary("catalog_search_songs", {
        keyword: "晴天", page: 1, pageSize: 20, generation,
      });
      if (!searched.ok) throw new Error("soak_search_failed");
      counters.search += 1;

      counters.cycles += 1;
      if (!faultRequested && Date.now() - started >= faultAfterMs) {
        faultRequested = true;
        process.stdout.write(`SOAK_FAULT_READY cycles=${counters.cycles}\n`);
      }
      process.stdout.write(
        `SOAK_STATUS cycles=${counters.cycles} liked=${counters.liked} created=${counters.created} favorite=${counters.favorite} search=${counters.search} queued=${counters.queued} plays=${counters.plays}\n`,
      );
      await browser.pause(250);
    }
    const snapshot = await invokeTauri("app_snapshot");
    if (!snapshot.ok) throw new Error("soak_final_snapshot_failed");
    process.stdout.write(`SOAK_COMPLETE cycles=${counters.cycles} provider=ready\n`);
  });
});

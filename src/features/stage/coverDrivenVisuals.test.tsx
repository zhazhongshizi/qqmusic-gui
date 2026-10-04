import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../../app/App";
import { playerActions, resetPlayerFixture } from "../player/playerStore";
import {
  clearPaletteCache,
  extractPaletteFromPixels,
  setCachedPalette,
} from "./coverPalette";

function seedLightPalette() {
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 220;
    pixels[i + 1] = 232;
    pixels[i + 2] = 220;
    pixels[i + 3] = 255;
  }
  setCachedPalette(
    "fixture-dusk-greenhouse",
    extractPaletteFromPixels(pixels, pixels.length, 32, 32),
  );
}

describe("封面驱动动态视觉集成", () => {
  beforeEach(() => {
    resetPlayerFixture();
    clearPaletteCache();
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
  });

  afterEach(() => {
    cleanup();
  });

  it("app-shell 默认挂载当前曲目的代表色与标准光晕强度 CSS 变量", () => {
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");
    expect(appShell).toBeInTheDocument();
    expect(appShell).toHaveAttribute("data-glow-motion", "still");
    expect(appShell).toHaveAttribute("data-glow-intensity", "standard");

    expect(appShell?.style.getPropertyValue("--cover-primary")).toBeTruthy();
    expect(appShell?.style.getPropertyValue("--cover-vibrant")).toBeTruthy();
    expect(appShell?.style.getPropertyValue("--cover-ambient")).toBeTruthy();
    expect(appShell?.style.getPropertyValue("--cover-glow-intensity")).toBe("1");
    expect(appShell).toHaveAttribute("data-cover-tone", "dark");
  });

  it("仅在 Normal 舞台且有曲目时输出 light tone，进入曲库后强制 dark", async () => {
    seedLightPalette();
    const user = userEvent.setup();
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");
    expect(appShell).toHaveAttribute("data-cover-tone", "light");

    await user.click(screen.getByRole("button", { name: "曲库" }));
    await screen.findByRole("heading", { name: "今日唱片目录" });
    expect(appShell).toHaveAttribute("data-cover-tone", "dark");

    await user.click(screen.getByRole("button", { name: "返回舞台" }));
    await waitFor(() => expect(appShell).toHaveAttribute("data-cover-tone", "light"));
  });

  it("Terminal 始终强制 dark，退出后恢复 Normal 舞台 tone", async () => {
    seedLightPalette();
    const user = userEvent.setup();
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");

    await user.click(screen.getByRole("button", { name: "进入终端模式" }));
    await screen.findByTestId("terminal-mini");
    expect(appShell).toHaveAttribute("data-cover-tone", "dark");

    await user.click(screen.getAllByRole("button", { name: "G GUI" })[0]!);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "进入终端模式" })).toBeInTheDocument();
      expect(appShell).toHaveAttribute("data-cover-tone", "light");
    });
  });

  it("无曲目与 dark palette 保持 dark，tone 变化不改变四档光晕和 playing/still 语义", async () => {
    seedLightPalette();
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");
    expect(appShell).toHaveAttribute("data-cover-tone", "light");
    expect(appShell).toHaveAttribute("data-glow-intensity", "standard");
    expect(appShell).toHaveAttribute("data-glow-motion", "still");

    playerActions.clearQueue();
    await waitFor(() => {
      expect(container.querySelector(".stage--empty")).toBeInTheDocument();
      expect(appShell).toHaveAttribute("data-cover-tone", "dark");
      expect(appShell).toHaveAttribute("data-glow-intensity", "standard");
      expect(appShell).toHaveAttribute("data-glow-motion", "still");
    });
  });

  it("轻量微光与原版均保留播放态动态，切换不改变播放", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");
    expect(appShell).toHaveAttribute("data-glow-motion", "still");

    playerActions.toggle();
    expect(appShell).toHaveAttribute("data-glow-renderer", "cached");
    await waitFor(() => expect(appShell).toHaveAttribute("data-glow-motion", "playing"));
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "轻量动态微光" }));
    expect(appShell).toHaveAttribute("data-glow-renderer", "original");
    await waitFor(() => expect(appShell).toHaveAttribute("data-glow-motion", "playing"));

    playerActions.seekBy(1_000);
    expect(appShell).toHaveAttribute("data-glow-motion", "playing");

    playerActions.toggle();
    await waitFor(() => expect(appShell).toHaveAttribute("data-glow-motion", "still"));
  });

  it("可从更多菜单调节封面光晕强度并更新 CSS 变量与 localStorage", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");

    // 打开更多菜单
    await user.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // 切换到 柔和 强度
    await user.click(screen.getByRole("menuitemradio", { name: "光晕：柔和" }));
    expect(appShell?.style.getPropertyValue("--cover-glow-intensity")).toBe("0.55");
    expect(localStorage.getItem("qqmusic_glow_intensity")).toBe("subtle");

    // 光晕调整后菜单保持打开，可连续切换强度。
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: "光晕：关闭" }));
    expect(appShell?.style.getPropertyValue("--cover-glow-intensity")).toBe("0");
    expect(localStorage.getItem("qqmusic_glow_intensity")).toBe("off");
  });

  it("切歌时调色板平滑更新对应的代表色", async () => {
    const { container } = render(<App />);
    const appShell = container.querySelector<HTMLElement>(".app-shell");
    const initialPrimary = appShell?.style.getPropertyValue("--cover-primary");

    // 切到下一首《纸月光》(accent: #9f9878)
    playerActions.next();

    await waitFor(() => {
      const nextPrimary = appShell?.style.getPropertyValue("--cover-primary");
      expect(nextPrimary).toBeTruthy();
      expect(nextPrimary).not.toBe(initialPrimary);
    });
  });

  it("ListeningStage 输出固定的纯装饰分层光场，空队列不伪造封面光核", async () => {
    const { container } = render(<App />);
    const ambient = container.querySelector(".stage__ambient");
    const artwork = container.querySelector(".stage .album-artwork");
    const playerBar = container.querySelector(".player-bar");
    const timeline = container.querySelector(".player-bar__timeline");

    expect(ambient).toBeInTheDocument();
    expect(artwork).toBeInTheDocument();
    expect(playerBar).toBeInTheDocument();
    expect(timeline).toBeInTheDocument();

    const glowLayers = container.querySelectorAll(".app-shell .stage__glow");
    expect(glowLayers).toHaveLength(2);
    expect(container.querySelector(".app-shell > .app-shell__ambient > .stage__glow--field")).toBeInTheDocument();
    expect(container.querySelector(".stage__glow--field")).toBeInTheDocument();
    expect(container.querySelector(".stage__glow--artwork-core")).toBeInTheDocument();
    expect(container.querySelector(".stage__glow--sky")).toBeNull();
    expect(container.querySelector(".stage__glow--side-left")).toBeNull();
    expect(container.querySelector(".stage__glow--side-right")).toBeNull();
    glowLayers.forEach((layer) => {
      expect(layer).toHaveAttribute("aria-hidden", "true");
      expect(layer.querySelector("button, a, [tabindex]")).toBeNull();
    });

    playerActions.clearQueue();
    await waitFor(() => {
      expect(container.querySelector(".stage--empty")).toBeInTheDocument();
      expect(container.querySelector(".stage__glow--artwork-core")).toBeNull();
    });
  });

  it("CSS 契约只让标准/增强播放态呼吸，并在 reduced-motion 下完全禁用", () => {
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n");

    expect(css).toContain('[data-glow-motion="playing"]');
    expect(css).toContain('[data-glow-intensity="standard"]');
    expect(css).toContain('[data-glow-intensity="enhanced"]');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(".stage__glow--field");
    expect(css).toContain("cover-glow-field-drift");
    expect(css).not.toContain(".stage__glow--sky");
    expect(css).not.toContain(".stage__glow--side-left");
    expect(css).not.toContain(".stage__glow--side-right");
    expect(css).toContain("animation: none");
    expect(css).toContain("transform");
    expect(css).toContain("opacity");
  });

  it("浅色表面 CSS 只在 cover tone 作用域覆盖播放页关键区域", () => {
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n");

    expect(css).toContain('.app-shell[data-cover-tone="light"]');
    expect(css).toContain("--cover-surface-base");
    expect(css).toContain("--cover-surface-raised");
    expect(css).toContain("--cover-surface-lowered");
    expect(css).toContain("--cover-on-surface");
    expect(css).toContain("--cover-on-surface-muted");
    expect(css).toContain(".top-bar");
    expect(css).toContain(".stage");
    expect(css).toContain(".player-bar");
    expect(css).toContain(".lyrics-scroll");
    expect(css).toContain(".player-bar__timeline");
    expect(css).toContain(".stage__quality-menu");
  });
});

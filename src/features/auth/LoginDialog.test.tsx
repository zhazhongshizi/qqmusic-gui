import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthQrEvent, QrLoginStart } from "../../contracts/auth";
import {
  LoginDialog,
  QR_SUCCESS_HOLD_MS,
  createQrObjectUrl,
} from "./LoginDialog";

const START: QrLoginStart = {
  sessionId: "session-1",
  loginMethod: "qq",
  mimeType: "image/png",
  imageBase64: "cXItZml4dHVyZQ==",
  expiresAtMs: 1_900_000_000_000,
  pollAfterMs: 250,
};

describe("QR login dialog", () => {
  const createObjectUrl = vi.fn((_blob: Blob) => "blob:qr-session-1");
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it("用 Blob Object URL 展示二维码，并在卸载时取消会话和撤销 URL", async () => {
    const client = {
      start: vi.fn(async () => START),
      poll: vi.fn(async () => ({ state: "waitingScan", sessionId: START.sessionId } as const)),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    const user = userEvent.setup();
    const view = render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /QQ 扫码/ }));
    expect(await screen.findByRole("img", { name: "QQ 登录二维码" })).toHaveAttribute(
      "src",
      "blob:qr-session-1",
    );
    expect(createObjectUrl).toHaveBeenCalledOnce();

    view.unmount();
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith(START.sessionId));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:qr-session-1");
  });

  it("只把公开账号状态交给应用，凭据不进入组件", async () => {
    const onAuthChange = vi.fn();
    let emit: (event: AuthQrEvent) => void = () => undefined;
    const client = {
      start: vi.fn(async () => START),
      subscribe: vi.fn(async (callback: (event: AuthQrEvent) => void) => {
        emit = callback;
        return () => undefined;
      }),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    const user = userEvent.setup();
    render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={onAuthChange}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /QQ 扫码/ }));
    await screen.findByRole("img", { name: "QQ 登录二维码" });
    await act(async () => emit({
      state: "authenticated",
      sessionId: START.sessionId,
      account: { musicId: "123456", loginMethod: "qq" },
    }));
    expect(await screen.findByRole("heading", { name: "登录成功" })).toBeInTheDocument();
    expect(onAuthChange).toHaveBeenCalledWith({
      state: "authenticated",
      account: { musicId: "123456", loginMethod: "qq" },
    });
    expect(JSON.stringify(onAuthChange.mock.calls)).not.toContain("credential");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:qr-session-1");
  });

  it("Object URL 构造只解码图像载荷", () => {
    expect(createQrObjectUrl(START)).toBe("blob:qr-session-1");
    const blob = createObjectUrl.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("image/png");
  });

  it("后台任务发出二维码终态后清理会话", async () => {
    let emit: (event: AuthQrEvent) => void = () => undefined;
    const client = {
      start: vi.fn(async () => START),
      subscribe: vi.fn(async (callback: (event: AuthQrEvent) => void) => {
        emit = callback;
        return () => undefined;
      }),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    const user = userEvent.setup();
    render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /QQ 扫码/ }));
    await act(async () => emit({ state: "expired", sessionId: START.sessionId }));
    expect(await screen.findByRole("alert")).toHaveTextContent("QMG-AUTH-EXPIRED");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:qr-session-1");
    expect(client.cancel).toHaveBeenCalledWith(START.sessionId);
  });

  it("认证后立即公开账号状态，并保留五秒成功反馈", async () => {
    vi.useFakeTimers();
    const onAuthChange = vi.fn();
    let emit: (event: AuthQrEvent) => void = () => undefined;
    const client = {
      start: vi.fn(async () => START),
      subscribe: vi.fn(async (callback: (event: AuthQrEvent) => void) => {
        emit = callback;
        return () => undefined;
      }),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={onAuthChange}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /QQ 扫码/ }));
      await Promise.resolve();
    });
    await act(async () => emit({
      state: "authenticated",
      sessionId: START.sessionId,
      account: { musicId: "123456", loginMethod: "qq" },
    }));
    expect(screen.getByText("凭据已安全保存，正在载入账号…")).toBeInTheDocument();
    expect(onAuthChange).toHaveBeenCalledWith({
      state: "authenticated",
      account: { musicId: "123456", loginMethod: "qq" },
    });
    expect(screen.queryByText("账号 123456")).not.toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(QR_SUCCESS_HOLD_MS - 1); });
    expect(screen.getByText("凭据已安全保存，正在载入账号…")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.getByText("账号 123456")).toBeInTheDocument();
  });

  it("后台登录事件直接公开 Rust 已保存的账号状态", async () => {
    vi.useFakeTimers();
    const onAuthChange = vi.fn();
    const account = { musicId: "779436361", loginMethod: "qq" } as const;
    let emit: (event: AuthQrEvent) => void = () => undefined;
    const client = {
      start: vi.fn(async () => START),
      poll: vi.fn(),
      subscribe: vi.fn(async (callback: (event: AuthQrEvent) => void) => {
        emit = callback;
        return () => undefined;
      }),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={onAuthChange}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /QQ 扫码/ }));
      await Promise.resolve();
    });
    await act(async () => emit({ state: "authenticated", sessionId: START.sessionId, account }));

    expect(client.poll).not.toHaveBeenCalled();
    expect(onAuthChange).toHaveBeenCalledWith({ state: "authenticated", account });
    expect(screen.getByText("凭据已安全保存，正在载入账号…")).toBeInTheDocument();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:qr-session-1");
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("事件丢失时通过本地认证快照完成一次兜底切换", async () => {
    vi.useFakeTimers();
    const onAuthChange = vi.fn();
    const account = { musicId: "779436361", loginMethod: "qq" } as const;
    const client = {
      start: vi.fn(async () => START),
      subscribe: vi.fn(async () => () => undefined),
      status: vi.fn(async () => ({ state: "authenticated", account } as const)),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={onAuthChange}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /QQ 扫码/ }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(client.status).toHaveBeenCalledOnce();
    expect(onAuthChange).toHaveBeenCalledWith({ state: "authenticated", account });
    expect(screen.getByText("凭据已安全保存，正在载入账号…")).toBeInTheDocument();
  });

  it("确认阶段轮询异常时停止自动重复登录请求", async () => {
    vi.useFakeTimers();
    let emit: (event: AuthQrEvent) => void = () => undefined;
    const client = {
      start: vi.fn(async () => START),
      poll: vi.fn(),
      subscribe: vi.fn(async (callback: (event: AuthQrEvent) => void) => {
        emit = callback;
        return () => undefined;
      }),
      cancel: vi.fn(async () => ({ state: "cancelled", sessionId: START.sessionId } as const)),
      logout: vi.fn(async () => ({ upstreamRevoked: true, coverCacheCleared: true })),
    };
    render(
      <LoginDialog
        auth={{ state: "signedOut" }}
        client={client}
        onAuthChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /QQ 扫码/ }));
      await Promise.resolve();
    });
    await act(async () => emit({
      state: "waitingConfirmation",
      sessionId: START.sessionId,
    }));
    expect(screen.getByText("已扫码，请在手机上确认登录")).toBeInTheDocument();

    await act(async () => emit({
      state: "error",
      sessionId: START.sessionId,
      code: "auth_qr_outcome_unknown",
      retryable: false,
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("QMG-AUTH-004");
    expect(client.cancel).toHaveBeenCalledWith(START.sessionId);
    expect(client.poll).not.toHaveBeenCalled();
  });
});

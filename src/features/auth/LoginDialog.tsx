import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import {
  AuthAdapterError,
  AUTH_ERROR_CODES,
  authLogout,
  authQrCancel,
  authQrPoll,
  authQrStart,
  authStatus,
  listenAuthQrEvents,
} from "../../backend/authAdapter";
import { Icon } from "../../components/Icon";
import type {
  AuthQrEvent,
  AuthSnapshot,
  LoginMethod,
  PublicAccount,
  QrLoginStart,
} from "../../contracts/auth";

const FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";
export const QR_MIN_VISIBLE_MS = 60_000;
export const QR_SUCCESS_HOLD_MS = 5_000;

type LoginScreen =
  | { readonly kind: "choose" }
  | { readonly kind: "loading"; readonly method: LoginMethod }
  | {
      readonly kind: "qr";
      readonly method: LoginMethod;
      readonly imageUrl: string;
      readonly state: "waitingScan" | "waitingConfirmation" | "verifying";
    }
  | { readonly kind: "successHold"; readonly account: PublicAccount }
  | { readonly kind: "success"; readonly account?: PublicAccount }
  | { readonly kind: "error"; readonly code: string; readonly detail?: string };

interface LoginDialogProps {
  auth: AuthSnapshot;
  onAuthChange: (snapshot: AuthSnapshot) => void;
  onClose: () => void;
}

interface AuthClient {
  start: typeof authQrStart;
  poll?: typeof authQrPoll;
  cancel: typeof authQrCancel;
  logout: typeof authLogout;
  status?: typeof authStatus;
  subscribe?: typeof listenAuthQrEvents;
}

const DEFAULT_CLIENT: AuthClient = {
  start: authQrStart,
  poll: authQrPoll,
  cancel: authQrCancel,
  logout: authLogout,
  status: authStatus,
  subscribe: listenAuthQrEvents,
};

export function createQrObjectUrl(start: QrLoginStart): string {
  const binary = atob(start.imageBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: start.mimeType }));
}

export function LoginDialog({
  auth,
  onAuthChange,
  onClose,
  client = DEFAULT_CLIENT,
}: LoginDialogProps & { client?: AuthClient }) {
  const [screen, setScreen] = useState<LoginScreen>(() => (
    auth.state === "authenticated"
      ? { kind: "success", account: auth.account }
      : { kind: "choose" }
  ));
  const dialogRef = useRef<HTMLElement>(null);
  const sessionRef = useRef<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const eventProcessorRef = useRef<((event: AuthQrEvent) => void) | null>(null);
  const pendingEventsRef = useRef<AuthQrEvent[]>([]);

  function revokeImage() {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
  }

  function stopTimer() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function stopStatusWatch() {
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = null;
  }

  function stopAuthEvents() {
    unlistenRef.current?.();
    unlistenRef.current = null;
    eventProcessorRef.current = null;
    pendingEventsRef.current = [];
  }

  function cancelActive() {
    generationRef.current += 1;
    stopTimer();
    stopStatusWatch();
    stopAuthEvents();
    revokeImage();
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    if (sessionId) void client.cancel(sessionId).catch(() => undefined);
  }

  useEffect(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current
      ?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ?.focus();
    return () => {
      generationRef.current += 1;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
      unlistenRef.current?.();
      unlistenRef.current = null;
      eventProcessorRef.current = null;
      pendingEventsRef.current = [];
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) void client.cancel(sessionId).catch(() => undefined);
      restoreFocus?.focus();
    };
  }, [client]);

  function close() {
    cancelActive();
    onClose();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  async function begin(method: LoginMethod) {
    cancelActive();
    const generation = generationRef.current;
    const previousAccountId = auth.state === "authenticated" ? auth.account?.musicId : undefined;
    setScreen({ kind: "loading", method });
    let activeSessionId: string | null = null;
    let imageUrl = "";
    let processEvent: ((event: AuthQrEvent) => void) | null = null;
    const receiveEvent = (event: AuthQrEvent) => {
      if (generationRef.current !== generation) return;
      if (activeSessionId === null) {
        pendingEventsRef.current.push(event);
        return;
      }
      if (event.sessionId === activeSessionId) processEvent?.(event);
    };
    try {
      const unlisten = client.subscribe ? await client.subscribe(receiveEvent) : () => undefined;
      if (generationRef.current !== generation) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
      const started = await client.start(method);
      if (generationRef.current !== generation) {
        unlisten();
        void client.cancel(started.sessionId).catch(() => undefined);
        return;
      }
      imageUrl = createQrObjectUrl(started);
      imageUrlRef.current = imageUrl;
      activeSessionId = started.sessionId;
      sessionRef.current = started.sessionId;
      setScreen({ kind: "qr", method, imageUrl, state: "waitingScan" });

      processEvent = (event) => {
        if (generationRef.current !== generation || event.sessionId !== started.sessionId) return;
        if (event.state === "waitingScan" || event.state === "waitingConfirmation") {
          setScreen({ kind: "qr", method, imageUrl, state: event.state });
          return;
        }
        if (event.state === "authenticated") {
          activeSessionId = null;
          sessionRef.current = null;
          stopStatusWatch();
          stopAuthEvents();
          onAuthChange({ state: "authenticated", account: event.account });
          revokeImage();
          setScreen({ kind: "successHold", account: event.account });
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            if (generationRef.current === generation) {
              setScreen({ kind: "success", account: event.account });
            }
          }, QR_SUCCESS_HOLD_MS);
          return;
        }
        if (event.state === "expired" || event.state === "rejected") {
          cancelActive();
          setScreen({
            kind: "error",
            code: event.state === "expired" ? "QMG-AUTH-EXPIRED" : "QMG-AUTH-REJECTED",
          });
          return;
        }
        const code = event.code === "auth_qr_outcome_unknown"
          ? AUTH_ERROR_CODES.outcomeUnknown
          : AUTH_ERROR_CODES.failed;
        cancelActive();
        setScreen({ kind: "error", code, detail: event.code });
      };
      eventProcessorRef.current = processEvent;
      const buffered = pendingEventsRef.current.filter(
        (event) => event.sessionId === started.sessionId,
      );
      pendingEventsRef.current = [];
      buffered.forEach((event) => processEvent?.(event));

      // The Rust bridge updates the in-memory auth snapshot before emitting the
      // renderer event. This local-only watchdog covers a WebView event missed
      // during reload without polling QQ or submitting another login request.
      const readStatus = client.status;
      if (readStatus && sessionRef.current === started.sessionId) {
        const checkSnapshot = async () => {
          statusTimerRef.current = null;
          if (
            generationRef.current !== generation
            || sessionRef.current !== started.sessionId
            || Date.now() >= started.expiresAtMs
          ) return;
          try {
            const snapshot = await readStatus();
            if (
              generationRef.current === generation
              && sessionRef.current === started.sessionId
              && snapshot.state === "authenticated"
              && snapshot.account
              && snapshot.account.musicId !== previousAccountId
            ) {
              processEvent?.({
                state: "authenticated",
                sessionId: started.sessionId,
                account: snapshot.account,
              });
              return;
            }
          } catch {
            // The event bridge remains authoritative; retry the local snapshot read.
          }
          if (
            generationRef.current === generation
            && sessionRef.current === started.sessionId
            && Date.now() < started.expiresAtMs
          ) {
            statusTimerRef.current = window.setTimeout(() => void checkSnapshot(), 1_500);
          }
        };
        statusTimerRef.current = window.setTimeout(() => void checkSnapshot(), 800);
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      cancelActive();
      setScreen({
        kind: "error",
        code: error instanceof AuthAdapterError ? error.code : AUTH_ERROR_CODES.failed,
      });
    }
  }

  async function logout() {
    setScreen({
      kind: "loading",
      method: auth.state === "authenticated" ? auth.account?.loginMethod ?? "qq" : "qq",
    });
    try {
      await client.logout();
      onAuthChange({ state: "signedOut" });
      setScreen({ kind: "choose" });
    } catch (error) {
      setScreen({
        kind: "error",
        code: error instanceof AuthAdapterError ? error.code : AUTH_ERROR_CODES.failed,
      });
    }
  }

  return createPortal(
    <div className="login-overlay">
      <section
        aria-labelledby="login-dialog-title"
        aria-modal="true"
        className="login-dialog"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="login-dialog__header">
          <div>
            <span className="section-label">账号</span>
            <h2 id="login-dialog-title">安全扫码登录</h2>
          </div>
          <button aria-label="关闭登录窗口" className="icon-button icon-button--quiet" onClick={close} type="button">
            <Icon name="close" size={18} />
          </button>
        </header>

        {screen.kind === "choose" ? (
          <div className="login-dialog__choose">
            <p>二维码只存在于本次登录会话；完整凭据仅保存到 Windows 凭据管理器。</p>
            <div className="login-dialog__methods">
              <button className="login-method login-method--qq" onClick={() => void begin("qq")} type="button">
                <strong>QQ 扫码</strong><span>使用手机 QQ</span>
              </button>
              <button className="login-method login-method--wx" onClick={() => void begin("wx")} type="button">
                <strong>微信扫码</strong><span>使用微信</span>
              </button>
            </div>
          </div>
        ) : null}

        {screen.kind === "loading" ? (
          <div aria-busy="true" className="login-dialog__loading" role="status">
            <div aria-hidden="true" className="loading-glyph"><span /><span /><span /></div>
            <p>正在获取{screen.method === "qq" ? " QQ" : "微信"}二维码…</p>
          </div>
        ) : null}

        {screen.kind === "qr" ? (
          <div className="login-dialog__qr">
            <div className="login-dialog__qr-frame">
              <img alt={`${screen.method === "qq" ? "QQ" : "微信"} 登录二维码`} src={screen.imageUrl} />
            </div>
            <p aria-live="polite">
              {screen.state === "waitingConfirmation"
                ? "已扫码，请在手机上确认登录"
                : screen.state === "verifying"
                  ? "状态异常，正在复核；二维码暂不清理"
                  : "请使用手机扫码"}
            </p>
            <button className="text-button" onClick={() => {
              cancelActive();
              setScreen({ kind: "choose" });
            }} type="button">更换登录方式</button>
          </div>
        ) : null}

        {screen.kind === "successHold" ? (
          <div className="login-dialog__result" role="status">
            <span aria-hidden="true" className="login-dialog__success-mark">✓</span>
            <h3>登录成功</h3>
            <p>凭据已安全保存，正在载入账号…</p>
            <button className="text-button text-button--primary" onClick={close} type="button">完成</button>
          </div>
        ) : null}

        {screen.kind === "success" ? (
          <div className="login-dialog__result" role="status">
            <span aria-hidden="true" className="login-dialog__success-mark">✓</span>
            <h3>登录成功</h3>
            <p>{screen.account ? `账号 ${screen.account.musicId}` : "登录状态已恢复"}</p>
            <div>
              <button className="text-button text-button--primary" onClick={close} type="button">完成</button>
              <button className="text-button" onClick={() => void logout()} type="button">退出登录</button>
            </div>
          </div>
        ) : null}

        {screen.kind === "error" ? (
          <div className="login-dialog__result" role="alert">
            <span aria-hidden="true" className="login-dialog__error-mark">!</span>
            <h3>登录未完成</h3>
            <p>
              {screen.code === AUTH_ERROR_CODES.outcomeUnknown
                ? "已停止自动重复请求，请重新获取二维码后再登录。"
                : "二维码已清理，可以重新获取。"}
              {screen.detail ? `底层状态：${screen.detail}。` : null}
              诊断编号：<code>{screen.code}</code>
            </p>
            <button className="text-button text-button--primary" onClick={() => {
              cancelActive();
              setScreen({ kind: "choose" });
            }} type="button">重试</button>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

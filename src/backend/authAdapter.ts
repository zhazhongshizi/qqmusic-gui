import { invalidateCatalogAccount, updateCatalogAccount } from "./catalogCacheScope";
import {
  AUTH_COMMANDS,
  type AuthQrEvent,
  type AuthSnapshot,
  type LoginMethod,
  type LogoutResult,
  type PublicAccount,
  type QrLoginStart,
  type QrLoginState,
} from "../contracts/auth";

export const AUTH_ERROR_CODES = {
  unavailable: "QMG-AUTH-001",
  invalid: "QMG-AUTH-002",
  failed: "QMG-AUTH-003",
  outcomeUnknown: "QMG-AUTH-004",
} as const;

export const AUTH_QR_RENDERER_EVENT = "auth_qr_event";

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export class AuthAdapterError extends Error {
  readonly code: AuthErrorCode;
  readonly detail?: string;

  constructor(code: AuthErrorCode, detail?: string) {
    super(code);
    this.name = "AuthAdapterError";
    this.code = code;
    this.detail = detail;
  }
}

const SNAPSHOT_BASE_KEYS = ["state"] as const;
const ACCOUNT_KEYS = ["musicId", "loginMethod"] as const;
const QR_START_KEYS = [
  "sessionId",
  "loginMethod",
  "mimeType",
  "imageBase64",
  "expiresAtMs",
  "pollAfterMs",
] as const;
const QR_STATE_BASE_KEYS = ["state", "sessionId"] as const;
const QR_STATE_ACCOUNT_KEYS = ["state", "sessionId", "account"] as const;
const QR_EVENT_ERROR_KEYS = ["state", "sessionId", "code", "retryable"] as const;
const LOGOUT_KEYS = ["upstreamRevoked", "coverCacheCleared"] as const;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function invalid(): never {
  throw new AuthAdapterError(AUTH_ERROR_CODES.invalid);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return invalid();

  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return invalid();
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function loginMethod(value: unknown): LoginMethod {
  return value === "qq" || value === "wx" ? value : invalid();
}

function parseAccount(value: unknown): PublicAccount {
  const record = exactRecord(value, ACCOUNT_KEYS);
  const musicId = boundedString(record.musicId, 32);
  if (!/^\d+$/.test(musicId)) return invalid();
  return { musicId, loginMethod: loginMethod(record.loginMethod) };
}

export function parseAuthSnapshot(value: unknown): AuthSnapshot {
  const hasAccount = typeof value === "object" && value !== null && "account" in value;
  const candidate = exactRecord(
    value,
    hasAccount
      ? ["state", "account"]
      : SNAPSHOT_BASE_KEYS,
  );
  if (candidate.state === "unavailable" && !hasAccount) return { state: "unavailable" };
  if (candidate.state === "signedOut" && !hasAccount) return { state: "signedOut" };
  if (candidate.state === "authenticated") {
    return hasAccount
      ? { state: "authenticated", account: parseAccount(candidate.account) }
      : { state: "authenticated" };
  }
  return invalid();
}

export function parseQrStart(value: unknown): QrLoginStart {
  const record = exactRecord(value, QR_START_KEYS);
  const imageBase64 = boundedString(record.imageBase64, 700_000);
  if (!BASE64_PATTERN.test(imageBase64)) return invalid();
  const mimeType = record.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return invalid();
  const pollAfterMs = safeInteger(record.pollAfterMs);
  if (pollAfterMs < 250 || pollAfterMs > 10_000) return invalid();
  return {
    sessionId: boundedString(record.sessionId, 128),
    loginMethod: loginMethod(record.loginMethod),
    mimeType,
    imageBase64,
    expiresAtMs: safeInteger(record.expiresAtMs),
    pollAfterMs,
  };
}

export function parseQrState(value: unknown): QrLoginState {
  const hasAccount = typeof value === "object" && value !== null && "account" in value;
  const record = exactRecord(value, hasAccount ? QR_STATE_ACCOUNT_KEYS : QR_STATE_BASE_KEYS);
  const sessionId = boundedString(record.sessionId, 128);
  switch (record.state) {
    case "waitingScan":
    case "waitingConfirmation":
    case "expired":
    case "rejected":
    case "cancelled":
      if (hasAccount) return invalid();
      return { state: record.state, sessionId };
    case "authenticated":
      if (!hasAccount) return invalid();
      return { state: "authenticated", sessionId, account: parseAccount(record.account) };
    default:
      return invalid();
  }
}

export function parseAuthQrEvent(value: unknown): AuthQrEvent {
  const hasAccount = typeof value === "object" && value !== null && "account" in value;
  const hasError = typeof value === "object" && value !== null && "code" in value;
  const record = exactRecord(
    value,
    hasAccount
      ? QR_STATE_ACCOUNT_KEYS
      : hasError
        ? QR_EVENT_ERROR_KEYS
        : QR_STATE_BASE_KEYS,
  );
  const sessionId = boundedString(record.sessionId, 128);
  switch (record.state) {
    case "waitingScan":
    case "waitingConfirmation":
    case "expired":
    case "rejected":
      if (hasAccount || hasError) return invalid();
      return { state: record.state, sessionId };
    case "authenticated":
      if (!hasAccount || hasError) return invalid();
      return { state: "authenticated", sessionId, account: parseAccount(record.account) };
    case "error":
      if (hasAccount || !hasError || typeof record.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(record.code)) {
        return invalid();
      }
      if (typeof record.retryable !== "boolean") return invalid();
      return { state: "error", sessionId, code: record.code, retryable: record.retryable };
    default:
      return invalid();
  }
}

function parseLogout(value: unknown): LogoutResult {
  const record = exactRecord(value, LOGOUT_KEYS);
  if (typeof record.upstreamRevoked !== "boolean" || typeof record.coverCacheCleared !== "boolean") return invalid();
  return {
    upstreamRevoked: record.upstreamRevoked,
    coverCacheCleared: record.coverCacheCleared,
  };
}

function safePublicErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as { code?: unknown }).code;
  return typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : undefined;
}

async function invoke(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  if (!isTauriRuntime()) throw new AuthAdapterError(AUTH_ERROR_CODES.unavailable);
  try {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return await tauriInvoke<unknown>(command, payload);
  } catch (error) {
    if (error instanceof AuthAdapterError) throw error;
    throw new AuthAdapterError(AUTH_ERROR_CODES.failed, safePublicErrorCode(error));
  }
}

export async function authStatus(): Promise<AuthSnapshot> {
  if (!isTauriRuntime()) return { state: "signedOut" };
  const result = parseAuthSnapshot(await invoke(AUTH_COMMANDS.status));
  updateCatalogAccount(result.state === "authenticated" ? result.account?.musicId ?? "authenticated" : result.state);
  return result;
}

let recoveryPromise: Promise<AuthSnapshot> | undefined;

export function authRecover(): Promise<AuthSnapshot> {
  if (!isTauriRuntime()) return Promise.resolve({ state: "signedOut" });
  if (!recoveryPromise) {
    const pending = invoke(AUTH_COMMANDS.recover).then(parseAuthSnapshot).then(result => {
      updateCatalogAccount(result.state === "authenticated" ? result.account?.musicId ?? "authenticated" : result.state);
      return result;
    });
    recoveryPromise = pending;
    void pending.finally(() => {
      if (recoveryPromise === pending) recoveryPromise = undefined;
    }).catch(() => undefined);
  }
  return recoveryPromise;
}

export async function authQrStart(method: LoginMethod): Promise<QrLoginStart> {
  return parseQrStart(await invoke(AUTH_COMMANDS.qrStart, { loginMethod: method }));
}

export async function authQrPoll(sessionId: string): Promise<QrLoginState> {
  const result = parseQrState(await invoke(AUTH_COMMANDS.qrPoll, { sessionId }));
  if ("account" in result) invalidateCatalogAccount();
  return result;
}

export async function listenAuthQrEvents(
  callback: (event: AuthQrEvent) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<unknown>(AUTH_QR_RENDERER_EVENT, (event) => {
    try {
      const parsed = parseAuthQrEvent(event.payload);
      if ("account" in parsed) invalidateCatalogAccount();
      callback(parsed);
    } catch {
      // Ignore malformed provider events; the Rust boundary remains authoritative.
    }
  });
}

export async function authQrCancel(sessionId: string): Promise<QrLoginState> {
  return parseQrState(await invoke(AUTH_COMMANDS.qrCancel, { sessionId }));
}

export async function authLogout(): Promise<LogoutResult> {
  try { return parseLogout(await invoke(AUTH_COMMANDS.logout)); }
  finally { invalidateCatalogAccount(); }
}

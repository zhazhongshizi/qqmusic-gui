export const AUTH_COMMANDS = {
  status: "auth_status",
  recover: "auth_recover",
  qrStart: "auth_qr_start",
  qrPoll: "auth_qr_poll",
  qrCancel: "auth_qr_cancel",
  logout: "auth_logout",
} as const;

export type LoginMethod = "qq" | "wx";

export interface PublicAccount {
  readonly musicId: string;
  readonly loginMethod: LoginMethod;
}

export type AuthSnapshot =
  | { readonly state: "unavailable" }
  | { readonly state: "signedOut" }
  | { readonly state: "authenticated"; readonly account?: PublicAccount };

export interface QrLoginStart {
  readonly sessionId: string;
  readonly loginMethod: LoginMethod;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly imageBase64: string;
  readonly expiresAtMs: number;
  readonly pollAfterMs: number;
}

export type QrLoginState =
  | { readonly state: "waitingScan"; readonly sessionId: string }
  | { readonly state: "waitingConfirmation"; readonly sessionId: string }
  | {
      readonly state: "authenticated";
      readonly sessionId: string;
      readonly account: PublicAccount;
    }
  | { readonly state: "expired"; readonly sessionId: string }
  | { readonly state: "rejected"; readonly sessionId: string }
  | { readonly state: "cancelled"; readonly sessionId: string };

export type AuthQrEvent =
  | { readonly state: "waitingScan"; readonly sessionId: string }
  | { readonly state: "waitingConfirmation"; readonly sessionId: string }
  | {
      readonly state: "authenticated";
      readonly sessionId: string;
      readonly account: PublicAccount;
    }
  | { readonly state: "expired"; readonly sessionId: string }
  | { readonly state: "rejected"; readonly sessionId: string }
  | {
      readonly state: "error";
      readonly sessionId: string;
      readonly code: string;
      readonly retryable: boolean;
    };

export interface LogoutResult {
  readonly upstreamRevoked: boolean;
  readonly coverCacheCleared: boolean;
}

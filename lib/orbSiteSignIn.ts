"use client";

/**
 * Sign in with Orb — the browser-site protocol, run in the page.
 *
 * This is the only web sign-in Orb has enabled on MAINNET. The legacy
 * `/init-sign-in` + `/poll-sign-in` QR flow this app used before answers
 * "Sign in with Orb is temporarily unavailable" and has been removed.
 *
 * How it works:
 *  1. The page POSTs `{state, codeChallenge}` to `https://orbapi.xyz/init-site-sign-in`.
 *     The browser's Origin header identifies the site; the backend fetches
 *     `<origin>/.well-known/orb-siwo.json` (served by
 *     `app/.well-known/orb-siwo.json/route.ts`) to confirm the site opted in.
 *     The first sign-in from a new origin answers `PROVISIONING` for a while
 *     (it can take a few minutes) and is retried.
 *  2. `READY` returns a QR code and an `orbapp://` deep link for the Orb app.
 *  3. The page polls `/poll-site-sign-in` every 2.5s until the approval
 *     expires (~5 minutes), then receives an id token and an access token.
 *
 * It must run in the browser, not behind a server proxy: the backend limits
 * these endpoints per client IP (12 inits and 120 polls a minute, 30 polls a
 * minute per session), so proxying every viewer through the server's shared
 * egress address would get sign-ins refused.
 *
 * The protocol issues NO refresh token. The access token lives ~10 minutes and
 * the session ends when it does (see `lib/orbSession.ts`); the viewer then
 * scans again. Preview deployments and localhost are on other origins that
 * are not opted in, so they cannot sign in. If a Content-Security-Policy is
 * ever added, `connect-src` must include https://orbapi.xyz.
 */

export const ORB_SIGN_IN_BASE_URL = "https://orbapi.xyz";

const SESSION = /^[0-9a-f]{64}$/;
const DEEP_LINK = /^orbapp:\/\/orb\/approve\?secret=[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_TOKEN_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 10_000;
/** Stays inside the backend's 30-per-minute per-session poll limit. */
const POLL_INTERVAL_MS = 2_500;
/** A first-time origin is provisioned before it can sign in; bound the wait. */
const PROVISIONING_RETRY_MS = 10_000;
const PROVISIONING_ATTEMPTS = 6;

export type SiteSignInTokens = { user_id: string; idToken: string; accessToken: string };
export type SiteSignInQr = { qrCode: string; deepLink: string; expiresAt: number };
export type SiteSignInFetch = (input: string, init: RequestInit) => Promise<Response>;
export type SiteSignInFailure = "expired" | "cancelled" | "unavailable" | "provisioning" | "invalid";

/** Failures a retry cannot fix; transient faults while polling are retried until expiry. */
export class SiteSignInError extends Error {
  constructor(message: string, readonly reason: SiteSignInFailure = "unavailable") {
    super(message);
    this.name = "SiteSignInError";
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomDigest = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Transport and server faults, as opposed to an answer the backend meant. */
class TransientFailure extends Error {}

export function signInWithOrb({
  onQr,
  onProvisioning,
  signal,
  baseUrl = ORB_SIGN_IN_BASE_URL,
  fetcher = (input, init) => fetch(input, init),
}: {
  onQr: (qr: SiteSignInQr) => void;
  onProvisioning?: () => void;
  signal?: AbortSignal;
  baseUrl?: string;
  fetcher?: SiteSignInFetch;
}): Promise<SiteSignInTokens> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });

  const check = () => {
    if (controller.signal.aborted) throw new SiteSignInError("Sign-in cancelled", "cancelled");
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      check();
      const cancel = () => {
        clearTimeout(timer);
        reject(new SiteSignInError("Sign-in cancelled", "cancelled"));
      };
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      controller.signal.addEventListener("abort", cancel, { once: true });
    });

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    check();
    const request = new AbortController();
    const cancel = () => request.abort();
    controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: request.signal,
          body: JSON.stringify(body),
        });
      } catch {
        check();
        throw new TransientFailure("Sign in with Orb is unreachable");
      }
      check();
      if (response.status >= 500 || response.status === 429) {
        throw new TransientFailure("Sign in with Orb is unavailable");
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        check();
        throw new TransientFailure("Sign in with Orb is unavailable");
      }
      if (!response.ok || !record(payload) || payload.status !== "SUCCESS" || !record(payload.data)) {
        throw new SiteSignInError("Sign in with Orb is unavailable");
      }
      return payload.data;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
    }
  }

  const run = async (): Promise<SiteSignInTokens> => {
    check();
    const state = randomDigest();
    const codeVerifier = randomDigest();
    const codeChallenge = await challengeFor(codeVerifier);

    let started: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < PROVISIONING_ATTEMPTS && !started; attempt += 1) {
      let data: Record<string, unknown>;
      try {
        data = await post("/init-site-sign-in", { state, codeChallenge });
      } catch (error) {
        throw error instanceof SiteSignInError ? error : new SiteSignInError("Sign in with Orb is unavailable");
      }
      if (data.phase === "PROVISIONING") {
        onProvisioning?.();
        await pause(PROVISIONING_RETRY_MS);
        continue;
      }
      started = data;
    }
    if (!started) throw new SiteSignInError("Sign in with Orb is still being set up", "provisioning");

    const { phase, session, qrCode, deepLink, expiresAt } = started;
    if (
      phase !== "READY" ||
      typeof session !== "string" || !SESSION.test(session) ||
      typeof deepLink !== "string" || !DEEP_LINK.test(deepLink) ||
      typeof qrCode !== "string" || !qrCode ||
      typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()
    ) {
      throw new SiteSignInError("Sign in with Orb is unavailable");
    }
    check();
    onQr({ qrCode, deepLink, expiresAt });

    // Poll for the approval's whole lifetime: a late scan still signs in.
    for (;;) {
      check();
      if (Date.now() >= expiresAt) throw new SiteSignInError("Sign-in expired", "expired");
      let data: Record<string, unknown>;
      try {
        data = await post("/poll-site-sign-in", { session, state, codeVerifier });
      } catch (error) {
        if (error instanceof TransientFailure) {
          await pause(POLL_INTERVAL_MS);
          continue;
        }
        throw error;
      }
      if (data.processed === true) {
        const { source, user_id: userId, idToken, accessToken, refreshToken } = data;
        const token = (value: unknown): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
        // A refresh token is never issued by this protocol; its presence means
        // this is not the credential set the protocol defines.
        if (
          source !== "lens" || typeof userId !== "string" || !ADDRESS.test(userId) ||
          !token(idToken) || !token(accessToken) || refreshToken !== undefined
        ) {
          throw new SiteSignInError("Invalid sign-in credentials", "invalid");
        }
        return { user_id: userId, idToken, accessToken };
      }
      if (data.processed !== false) throw new SiteSignInError("Sign in with Orb is unavailable");
      await pause(POLL_INTERVAL_MS);
    }
  };

  return run().finally(() => {
    signal?.removeEventListener("abort", abort);
    controller.abort();
  });
}

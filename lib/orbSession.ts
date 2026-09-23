"use client";

import { useCallback, useEffect, useState } from "react";
import { getTokenExpiry, isTokenExpired } from "@orbclub/modules/auth";
import { getLensAccountFromAccessToken } from "@orbclub/modules/auth/lens";
import type { SiteSignInTokens } from "./orbSiteSignIn";

/**
 * The in-memory Orb session. Browser-site Sign in with Orb issues no refresh
 * token and the access token lives ~10 minutes, so the session ends exactly
 * when the token does and the viewer is asked to scan again. Nothing is
 * persisted to storage.
 */
export type OrbSession = {
  accessToken: string;
  idToken: string;
  user_id: string;
  account: string | null;
  userId: string | null;
  handle: string | null;
  /** When the access token expires (ms since epoch). */
  expiresAt: number;
};

/** Build a session from sign-in tokens; throws if the token is malformed, expired or for another account. */
export function sessionFromSignIn(tokens: SiteSignInTokens): OrbSession {
  const expiry = getTokenExpiry(tokens.accessToken)?.getTime();
  const account = getLensAccountFromAccessToken(tokens.accessToken);
  if (!expiry || !Number.isFinite(expiry) || isTokenExpired(tokens.accessToken)) {
    throw new Error("Orb returned an expired sign-in. Scan again.");
  }
  if (account && account.toLowerCase() !== tokens.user_id.toLowerCase()) {
    throw new Error("Orb sign-in account mismatch. Scan again.");
  }
  return {
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    user_id: tokens.user_id,
    account,
    userId: tokens.user_id,
    handle: null,
    expiresAt: expiry,
  };
}

/**
 * Holds the Orb session and clears it the moment its access token expires
 * (re-checked when a throttled background tab becomes visible again).
 * `expired` is true when the last session ended by expiry rather than logout.
 */
export function useOrbSession() {
  const [session, setSessionState] = useState<OrbSession | null>(null);
  const [expired, setExpired] = useState(false);

  const setSession = useCallback((next: OrbSession | null) => {
    setExpired(false);
    setSessionState(next);
  }, []);

  useEffect(() => {
    if (!session) return;
    const expireIfDue = () => {
      if (session.expiresAt <= Date.now()) {
        setSessionState(null);
        setExpired(true);
        return true;
      }
      return false;
    };
    if (expireIfDue()) return;
    const timer = window.setTimeout(expireIfDue, Math.min(session.expiresAt - Date.now(), 2_147_483_647));
    const onVisible = () => {
      if (document.visibilityState === "visible") expireIfDue();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session]);

  return { session, setSession, expired };
}

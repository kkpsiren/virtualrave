"use client";

import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress } from "viem";
import {
  CredentialsStorage,
  InMemoryStorageProvider,
  type Credentials,
} from "@lens-protocol/storage";
import { PublicClient, mainnet, type SessionClient } from "@lens-protocol/client";
import { isTokenExpired } from "@orbclub/modules/auth";
import type { OrbSession } from "./orbSession";

type LensSessionStatus = "idle" | "authenticating" | "authenticated" | "error";

interface UseLensSessionResult {
  sessionClient: SessionClient | null;
  status: LensSessionStatus;
  error: string | null;
  needsReauth: boolean;
  login: () => Promise<SessionClient | null>;
  logout: () => void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getStringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

type OrbResumeResult = {
  client: SessionClient | null;
  needsReauth: boolean;
  error: string | null;
};

async function resumeSessionFromOrb(orbSession: OrbSession | null): Promise<OrbResumeResult> {
  const accessToken = getStringField(orbSession?.accessToken);
  const idToken = getStringField(orbSession?.idToken);

  if (!accessToken) {
    return {
      client: null,
      needsReauth: Boolean(orbSession),
      error: orbSession ? "Orb session did not include an access token." : null,
    };
  }

  // Browser-site Sign in with Orb issues no refresh token: an expired access
  // token means the viewer has to scan again.
  if (!idToken || isTokenExpired(accessToken)) {
    return {
      client: null,
      needsReauth: true,
      error: idToken ? "Orb session expired. Scan Orb again." : "Orb session is missing the Lens id token.",
    };
  }

  const storage = new InMemoryStorageProvider();
  const stored = await CredentialsStorage.from(storage, "mainnet").set({
    accessToken,
    idToken,
    refreshToken: "",
  } as unknown as Credentials);

  if (stored.isErr()) {
    return {
      client: null,
      needsReauth: true,
      error: errorMessage(stored.error),
    };
  }

  const publicClient = PublicClient.create({
    environment: mainnet,
    origin: typeof window !== "undefined" ? window.location.origin : "https://vr303.local",
    storage,
  });
  const result = await publicClient.resumeSession();

  return result.isOk()
    ? { client: result.value, needsReauth: false, error: null }
    : { client: null, needsReauth: true, error: errorMessage(result.error) };
}

export function useLensSession(orbSession: OrbSession | null): UseLensSessionResult {
  const [sessionClient, setSessionClient] = useState<SessionClient | null>(null);
  const [status, setStatus] = useState<LensSessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  const candidate = orbSession?.userId ?? orbSession?.account ?? null;
  const lensAccountAddress =
    candidate && isAddress(candidate) ? getAddress(candidate) : null;

  useEffect(() => {
    if (!lensAccountAddress) {
      setSessionClient(null);
      setStatus("idle");
      setError(null);
      setNeedsReauth(false);
    }
  }, [lensAccountAddress]);

  const resumeOrbSessionIntoState = useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!lensAccountAddress) return null;
    if (sessionClient) return sessionClient;

    setStatus("authenticating");
    setError(null);
    setNeedsReauth(false);

    try {
      const orbResume = await resumeSessionFromOrb(orbSession);
      if (!isCurrent()) return null;
      if (orbResume.client) {
        setSessionClient(orbResume.client);
        setStatus("authenticated");
        return orbResume.client;
      }
      if (orbResume.needsReauth) {
        setSessionClient(null);
        setNeedsReauth(true);
        setStatus("error");
        setError(orbResume.error ?? "Orb session expired. Scan Orb again.");
        return null;
      }
      setSessionClient(null);
      setStatus("idle");
      return null;
    } catch (err) {
      if (!isCurrent()) return null;
      setSessionClient(null);
      setNeedsReauth(true);
      setStatus("error");
      setError(errorMessage(err));
      return null;
    }
  }, [lensAccountAddress, sessionClient, orbSession]);

  useEffect(() => {
    if (!lensAccountAddress || sessionClient) return;
    let active = true;
    void resumeOrbSessionIntoState(() => active);
    return () => {
      active = false;
    };
  }, [lensAccountAddress, resumeOrbSessionIntoState, sessionClient]);

  const login = useCallback(async () => {
    if (!lensAccountAddress) return null;
    if (sessionClient) return sessionClient;

    return resumeOrbSessionIntoState();
  }, [lensAccountAddress, sessionClient, resumeOrbSessionIntoState]);

  const logout = useCallback(() => {
    setSessionClient(null);
    setStatus("idle");
    setError(null);
    setNeedsReauth(false);
  }, []);

  return { sessionClient, status, error, needsReauth, login, logout };
}

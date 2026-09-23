"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SiteSignInError, signInWithOrb } from "@/lib/orbSiteSignIn";
import { sessionFromSignIn, type OrbSession } from "@/lib/orbSession";

export type { OrbSession };

interface OrbLoginPanelProps {
  session: OrbSession | null;
  onAuthenticated: (session: OrbSession) => void;
  onLogout: () => void;
  onAuthSuccess?: () => void;
  /** The previous session ended because its ~10-minute access token expired. */
  sessionExpired?: boolean;
}

type OrbStatus = "idle" | "connecting" | "authenticated" | "error";

function shortValue(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function getErrorMessage(error: unknown) {
  if (error instanceof SiteSignInError) {
    switch (error.reason) {
      case "expired":
        return "QR expired. Tune in again for a new code.";
      case "provisioning":
        return "Orb is still setting up sign-in for this site. Try again in a few minutes.";
      case "invalid":
        return "Orb returned an invalid sign-in. Try again.";
      default:
        return "Sign in with Orb is unavailable right now. Try again.";
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Orb login failed. Try again.";
}

/** Touch devices can't scan their own screen: offer the Orb app deep link. */
function usePrefersDeepLink() {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return coarse;
}

// ----- Encrypted-hex noise (0x202AC1D repeating, with block-glyph glitches) -
const CIPHER = "0x202AC1D";
const GLITCH_CHARS = "█▒░▓■□◊·—";
function cipherLine(len: number, glitchRate: number) {
  let out = "";
  while (out.length < len) {
    for (let i = 0; i < CIPHER.length && out.length < len; i++) {
      out +=
        Math.random() < glitchRate
          ? GLITCH_CHARS[(Math.random() * GLITCH_CHARS.length) | 0]
          : CIPHER[i];
    }
    if (out.length < len) out += " ";
  }
  return out.slice(0, len);
}
function noiseBlock(rows = 12, cols = 26, glitchRate = 0.18) {
  return Array.from({ length: rows }, () => cipherLine(cols, glitchRate)).join("\n");
}

// ----- WebAudio: static loop while NO SIGNAL, sine drone while QR -----------
type AmbientMode = "off" | "static" | "sine";

function useAmbientAudio(mode: AmbientMode) {
  const ctxRef = useRef<AudioContext | null>(null);
  // static loop refs
  const staticSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const staticGainRef = useRef<GainNode | null>(null);
  // sine drone refs
  const sineOscRef = useRef<OscillatorNode | null>(null);
  const sineOsc2Ref = useRef<OscillatorNode | null>(null);
  const sineGainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;

    let ctx = ctxRef.current;
    if (!ctx) {
      try {
        ctx = new AC();
        ctxRef.current = ctx;
      } catch {
        return;
      }
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    // helpers
    const fadeOutStatic = () => {
      const g = staticGainRef.current;
      const s = staticSrcRef.current;
      if (g && ctx) {
        try { g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15); } catch {}
      }
      window.setTimeout(() => { try { s?.stop(); } catch {} }, 200);
      staticSrcRef.current = null;
      staticGainRef.current = null;
    };
    const fadeOutSine = () => {
      const g = sineGainRef.current;
      const o1 = sineOscRef.current;
      const o2 = sineOsc2Ref.current;
      if (g && ctx) {
        try { g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25); } catch {}
      }
      window.setTimeout(() => {
        try { o1?.stop(); } catch {}
        try { o2?.stop(); } catch {}
      }, 300);
      sineOscRef.current = null;
      sineOsc2Ref.current = null;
      sineGainRef.current = null;
    };

    if (mode === "off") {
      fadeOutStatic();
      fadeOutSine();
      return;
    }

    if (mode === "static") {
      fadeOutSine();
      if (!staticSrcRef.current) {
        const buf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 2200;
        filter.Q.value = 0.4;
        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        src.start();
        gain.gain.exponentialRampToValueAtTime(0.045, ctx.currentTime + 0.18);
        staticSrcRef.current = src;
        staticGainRef.current = gain;
      }
      return () => { fadeOutStatic(); };
    }

    // mode === "sine"
    fadeOutStatic();
    if (!sineOscRef.current) {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = "sine";
      osc2.type = "sine";
      osc1.frequency.value = 220;
      osc2.frequency.value = 277; // soft minor-ish detune
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start();
      osc2.start();
      gain.gain.exponentialRampToValueAtTime(0.018, ctx.currentTime + 0.4);
      sineOscRef.current = osc1;
      sineOsc2Ref.current = osc2;
      sineGainRef.current = gain;
    }
    return () => { fadeOutSine(); };
  }, [mode]);

  const click = (kind: "tune" | "success" = "tune") => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "success" ? "square" : "sawtooth";
    osc.frequency.setValueAtTime(kind === "success" ? 880 : 320, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      kind === "success" ? 1760 : 90,
      ctx.currentTime + 0.18,
    );
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  };

  return { click };
}

// ----- Rolling ASCII layer ------------------------------------------------
function AsciiNoise({ rows = 12, cols = 26, hz = 18 }: { rows?: number; cols?: number; hz?: number }) {
  const [block, setBlock] = useState(() => noiseBlock(rows, cols));
  useEffect(() => {
    const id = window.setInterval(() => setBlock(noiseBlock(rows, cols)), 1000 / hz);
    return () => window.clearInterval(id);
  }, [rows, cols, hz]);
  return <div className="orb-crt__ascii">{block}</div>;
}

export function OrbLoginPanel({
  session,
  onAuthenticated,
  onLogout,
  onAuthSuccess,
  sessionExpired = false,
}: OrbLoginPanelProps) {
  const idleMessage = sessionExpired
    ? "Orb session expired. Scan again to keep collecting."
    : "Tune in. Scan with Orb to collect on your Lens profile.";
  const prefersDeepLink = usePrefersDeepLink();
  const [status, setStatus] = useState<OrbStatus>(session ? "authenticated" : "idle");
  const [message, setMessage] = useState(session ? "Orb session ready." : idleMessage);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justAuthed, setJustAuthed] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const showSuccessPre = justAuthed || (session && status === "authenticated");
  const ambientMode: "off" | "static" | "sine" = showSuccessPre
    ? "off"
    : qrCode
      ? "sine"
      : "static";
  const audio = useAmbientAudio(ambientMode);

  useEffect(() => {
    if (session) {
      setStatus("authenticated");
      setMessage("Orb session ready.");
      setQrCode(null);
      setDeepLink(null);
      setError(null);
    } else if (status === "authenticated") {
      setStatus("idle");
      setMessage(idleMessage);
      setJustAuthed(false);
    }
  }, [session, status, idleMessage]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  async function startLogin() {
    controllerRef.current?.abort();

    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus("connecting");
    setMessage("Tuning frequency...");
    setQrCode(null);
    setDeepLink(null);
    setError(null);

    try {
      const tokens = await signInWithOrb({
        signal: controller.signal,
        onProvisioning: () => {
          setMessage("Orb is setting up sign-in for this site. First time can take a few minutes...");
        },
        onQr: ({ qrCode: nextQrCode, deepLink: nextDeepLink }) => {
          setQrCode(nextQrCode);
          setDeepLink(nextDeepLink);
          setMessage("Signal locked. Scan with Orb.");
          audio.click("tune");
        },
      });

      if (controller.signal.aborted) return;

      onAuthenticated(sessionFromSignIn(tokens));
      setJustAuthed(true);
      setMessage("Orb connected.");
      audio.click("success");
      if (onAuthSuccess) {
        window.setTimeout(() => onAuthSuccess(), 950);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus("error");
      setMessage("Transmission failed.");
      setError(getErrorMessage(err));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }

  function cancelLogin() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus(session ? "authenticated" : "idle");
    setMessage(session ? "Orb session ready." : idleMessage);
    setQrCode(null);
    setDeepLink(null);
    setError(null);
  }

  const orbIdentity = session?.userId
    ? shortValue(session.userId)
    : session?.account
      ? shortValue(session.account)
      : null;

  const showSuccess = showSuccessPre;
  const noiseHz = useMemo(() => (status === "connecting" ? 22 : 12), [status]);

  return (
    <div className="orb-login">
      <div className="orb-login__head">
        <div>
          <div className="orb-login__tag">ORB LOGIN  OPTIONAL</div>
          <strong>{session ? "lens profile ready" : "for lens profile collect"}</strong>
        </div>
        <span className={`orb-login__status orb-login__status--${status}`}>
          {status}
        </span>
      </div>

      <div
        className={
          "orb-crt" +
          (qrCode && !showSuccess ? " orb-crt--qr" : "") +
          (showSuccess ? " orb-crt--success" : "")
        }
      >
        {showSuccess ? (
          <div className="orb-crt__stamp">
            <span className="orb-crt__stamp-check"></span>
            <span className="orb-crt__stamp-text">CONNECTED</span>
            <span className="orb-crt__stamp-sub">orb  lens  ready</span>
          </div>
        ) : qrCode ? (
          <div className="orb-crt__qr orb-crt__qr--clean">
            <img src={qrCode} alt="Orb login QR code" />
          </div>
        ) : (
          <>
            <AsciiNoise rows={14} cols={28} hz={noiseHz} />
            <div className="orb-crt__center">
              <div className="orb-crt__big">
                {status === "connecting" ? "TUNING" : "NO SIGNAL"}
              </div>
              <div className="orb-crt__sub">
                {status === "connecting" ? "stand by..." : "ch 303 / orb / lens"}
              </div>
            </div>
            <span className="orb-crt__label orb-crt__label--tl orb-crt__label--blink">REC</span>
            <span className="orb-crt__label orb-crt__label--tr">{status === "connecting" ? "BUSY" : "DEAD"}</span>
            <span className="orb-crt__label orb-crt__label--bl">VHS-303</span>
            <span className="orb-crt__label orb-crt__label--br">{new Date().getFullYear()}</span>
            <div className="orb-crt__tear" />
            <div className="orb-crt__tear orb-crt__tear--b" />
            <div className="orb-crt__scan" />
            <div className="orb-crt__noise" />
            <div className="orb-crt__vignette" />
          </>
        )}
      </div>

      <p className="orb-login__message">{message}</p>
      {orbIdentity ? (
        <p className="orb-login__identity">
          {session?.handle ? `${session.handle}  ` : ""}Orb wallet: {orbIdentity}
        </p>
      ) : null}
      {error ? <p className="orb-login__error">{error}</p> : null}

      <div className="orb-login__actions">
        {status === "connecting" ? (
          <button type="button" className="orb-login__button" onClick={cancelLogin}>
            cancel
          </button>
        ) : session ? (
          <button type="button" className="orb-login__button" onClick={onLogout}>
            log out orb
          </button>
        ) : (
          <button type="button" className="orb-login__button" onClick={startLogin}>
            login with orb
          </button>
        )}
        {deepLink && prefersDeepLink && status === "connecting" ? (
          <a className="orb-login__button orb-login__button--link" href={deepLink}>
            open orb app
          </a>
        ) : null}
      </div>
    </div>
  );
}

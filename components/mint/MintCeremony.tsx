"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import {
  createMintAudio,
  getStoredMute,
  type MintAudioController,
} from "@/lib/mintAudio";
import { getVr303Artwork } from "@/lib/vr303Artwork";
import {
  RAVE_BAR_SEC,
  RAVE_BEAT_SEC,
  type BeatTick,
} from "@/lib/raveClock";
import { CONTRACT } from "@/lib/wagmi";
import { VR303_MINT_POST_ACTION, VR303_PRICE_WEI } from "@/lib/vr303Action";
import { formatUnits } from "viem";

const Scene = dynamic(() => import("./MintCeremonyScene"), { ssr: false });

export type CeremonyAct = 0 | 1 | 2 | 3 | 4 | -1;

export interface CeremonyContext {
  edition: number;
  wallet: string;
  /** Lens profile handle if minted via Orb (e.g. "lens/sargent.lens" or "sargent") */
  lensHandle?: string | null;
  /** Lens profile address (the address that owns the NFT, if different from the signer wallet) */
  lensAddress?: string | null;
  txHash: string | null;
  blockNumber: number | null;
  mintedAt?: number | null;
  errorMessage: string | null;
}

interface MintCeremonyProps {
  open: boolean;
  act: CeremonyAct;
  ctx: CeremonyContext;
  buttonRect: DOMRect | null;
  onClose: () => void;
  /** Live chain-stream lines from the parent (real debug log). Most-recent last. */
  liveLog?: string[];
}

const CIPHER = "0x303AC1D";
const GLITCH_GLYPHS = "█▒░▓■□◊·—";

function cipherLine(len: number, glitchRate = 0.18): string {
  let out = "";
  while (out.length < len) {
    for (let i = 0; i < CIPHER.length && out.length < len; i++) {
      out += Math.random() < glitchRate
        ? GLITCH_GLYPHS[(Math.random() * GLITCH_GLYPHS.length) | 0]
        : CIPHER[i];
    }
    if (out.length < len) out += " ";
  }
  return out.slice(0, len);
}

function LiveChainStream({ lines }: { lines: string[] }) {
  // Show the last ~3 lines from the chain stream; type the newest one character by character.
  const tail = lines.slice(-3);
  const latest = tail[tail.length - 1] ?? "";
  const prior = tail.slice(0, -1);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!latest) {
      setTyped("");
      return;
    }
    // Type only the first line of the entry (headers are HH:MM:SS  label)
    const firstLineEnd = latest.indexOf("\n");
    const header = firstLineEnd === -1 ? latest : latest.slice(0, firstLineEnd);
    setTyped("");
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      if (i >= header.length) {
        setTyped(header);
        window.clearInterval(id);
        return;
      }
      setTyped(header.slice(0, i));
    }, 14);
    return () => window.clearInterval(id);
  }, [latest]);

  return (
    <div className="mc-livelog">
      <div className="mc-livelog__head">
        <span className="mc-livelog__dot" />
        chain stream · live
      </div>
      <div className="mc-livelog__body">
        {prior.map((line, i) => {
          const headerEnd = line.indexOf("\n");
          const head = headerEnd === -1 ? line : line.slice(0, headerEnd);
          return (
            <span key={i} className="mc-livelog__line">
              <span className="mc-livelog__prefix">›</span>
              {head}
            </span>
          );
        })}
        <span className="mc-livelog__line mc-livelog__line--latest">
          <span className="mc-livelog__prefix">›</span>
          {typed}
        </span>
      </div>
    </div>
  );
}

function CipherStrip({ lines = 3, cols = 90 }: { lines?: number; cols?: number }) {
  const [block, setBlock] = useState(() =>
    Array.from({ length: lines }, () => cipherLine(cols)).join("\n"),
  );
  useEffect(() => {
    const id = window.setInterval(
      () => setBlock(Array.from({ length: lines }, () => cipherLine(cols)).join("\n")),
      90,
    );
    return () => window.clearInterval(id);
  }, [lines, cols]);
  return <pre className="mc-cipher">{block}</pre>;
}


export function MintCeremony({ open, act, ctx, buttonRect, onClose, liveLog }: MintCeremonyProps) {
  const [mounted, setMounted] = useState(false);
  const [audio, setAudio] = useState<MintAudioController | null>(null);
  const [muted, setMuted] = useState(false);
  const [runId, setRunId] = useState(0);
  const [tick, setTick] = useState<BeatTick>({
    ctxTime: 0,
    beat: 0,
    bar: 0,
    step: 0,
    phase: 0,
    totalBeats: 0,
  });
  const startedRef = useRef(false);
  const wasOpenRef = useRef(false);
  const dragY = useMotionValue(0);
  const stubOpacity = useTransform(dragY, [0, 80, 200], [1, 1, 0]);
  const tearAngle = useTransform(dragY, [0, 200], [0, 12]);

  useEffect(() => {
    setMounted(true);
    setMuted(getStoredMute());
  }, []);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setRunId((id) => id + 1);
      setTick({
        ctxTime: 0,
        beat: 0,
        bar: 0,
        step: 0,
        phase: 0,
        totalBeats: 0,
      });
      dragY.set(0);
    }
    wasOpenRef.current = open;
  }, [open, dragY]);

  // boot audio when ceremony opens
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    let controller: MintAudioController | null = null;
    (async () => {
      try {
        controller = await createMintAudio();
        if (cancelled) {
          controller.stop();
          return;
        }
        await controller.start();
        controller.setMuted(getStoredMute());
        const unsub = controller.clock.subscribe((t) => {
          const stepBoundary = Math.floor(t.totalBeats * 8);
          if (stepBoundary !== Math.floor((t.totalBeats - 0.0001) * 8)) {
            setTick(t);
          }
        });
        setAudio(controller);
        // store cleanup on the controller object so we can detach later
        (controller as MintAudioController & { _unsub?: () => void })._unsub = () => unsub();
      } catch (err) {
        // audio failed — ceremony still runs silently
        console.warn("[mint] audio init failed", err);
      }
    })();
    return () => {
      cancelled = true;
      const c = controller as (MintAudioController & { _unsub?: () => void }) | null;
      if (c) {
        c._unsub?.();
        c.stop();
      }
      startedRef.current = false;
    };
  }, [open]);

  // trigger drop when act 3 starts
  const lastActRef = useRef<CeremonyAct | null>(null);
  useEffect(() => {
    if (act === 3 && lastActRef.current !== 3) {
      audio?.triggerDrop();
    }
    lastActRef.current = act;
  }, [act, audio]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    audio?.setMuted(next);
  }

  function handleTearEnd() {
    if (dragY.get() > 90) {
      onClose();
    } else {
      dragY.set(0);
    }
  }

  if (!mounted || !open) return null;

  const initialRect = buttonRect
    ? {
        top: buttonRect.top,
        left: buttonRect.left,
        width: buttonRect.width,
        height: buttonRect.height,
        borderRadius: 0,
      }
    : { top: "50%", left: "50%", width: 0, height: 0, borderRadius: 0 };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="mc-root"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          {/* button-eats-page: expanding rectangle from button rect → full viewport */}
          <motion.div
            className="mc-expander"
            initial={initialRect}
            animate={{ top: 0, left: 0, width: "100vw", height: "100vh", borderRadius: 0 }}
            transition={{ duration: 0.6, ease: [0.85, 0, 0.15, 1] }}
          >
            <Scene
              key={`scene-${runId}`}
              act={act}
              beatPhase={tick.phase}
              totalBeats={tick.totalBeats}
              audioLevel={1 - tick.phase}
            />

            {/* TOP-LEFT corner ID */}
            <div className="mc-corner mc-corner--tl">
              <div className="mc-corner__tag">RAVE-PROTOCOL-303</div>
              <div className="mc-corner__sub">// 134 BPM // LENS // CH 232</div>
            </div>

            {/* TOP-RIGHT live tick */}
            <div className="mc-corner mc-corner--tr">
              <div className="mc-corner__tag">BAR {String(tick.bar + 1).padStart(2, "0")} / BEAT {tick.beat + 1}</div>
              <div className="mc-corner__sub">
                ACT {act === -1 ? "STATIC" : act} —{" "}
                {act === 0
                  ? "BROADCASTING"
                  : act === 1
                    ? "DECRYPTING"
                    : act === 2
                      ? "CONFIRMING"
                      : act === 3
                        ? "THE DROP"
                        : act === 4
                          ? "ADMITTED"
                          : "SIGNAL LOST"}
              </div>
            </div>

            {/* TOP cipher rain */}
            <div className="mc-cipher-top">
              <CipherStrip lines={2} cols={120} />
            </div>

            {/* BOTTOM cipher rain */}
            <div className="mc-cipher-bot">
              <CipherStrip lines={2} cols={120} />
            </div>

            {/* CENTER content per act */}
            <div className="mc-center">
              {act === 0 && <Act0 wallet={ctx.wallet} />}
              {act === 1 && <Act1 txHash={ctx.txHash} />}
              {act === 2 && <Act2 txHash={ctx.txHash} blockNumber={ctx.blockNumber} wallet={ctx.wallet} />}
              {act === 3 && <Act3 edition={ctx.edition} />}
              {act === 4 && (
                <Act4Ticket
                  ctx={ctx}
                  dragY={dragY}
                  stubOpacity={stubOpacity}
                  tearAngle={tearAngle}
                  onTearEnd={handleTearEnd}
                  onClose={onClose}
                />
              )}
              {act === -1 && <ActError message={ctx.errorMessage ?? "Signal lost. Try again."} onClose={onClose} />}
            </div>

            {/* LIVE CHAIN STREAM */}
            {liveLog && liveLog.length > 0 && (
              <LiveChainStream lines={liveLog} />
            )}

            {/* MUTE TOGGLE */}
            <button
              className="mc-mute"
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted ? "♪ MUTED" : "♪ LIVE"}
            </button>

            {/* DISMISS — only shown outside the tear-flow */}
            {act !== 4 && act !== -1 && (
              <button className="mc-dismiss" onClick={onClose} aria-label="Close">
                ✕ ABORT
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------- ACTS ----------

function Act0({ wallet }: { wallet: string }) {
  return (
    <motion.div
      key="act0"
      className="mc-act mc-act--0"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.4 }}
    >
      <div className="mc-act__title">BROADCASTING</div>
      <div className="mc-act__sub">
        &gt; signed by {wallet.slice(0, 8)}...{wallet.slice(-6)}  payload in flight
        <span className="mc-caret" />
      </div>
      <div className="mc-act__hint">your transaction is on the wire</div>
    </motion.div>
  );
}

const DECRYPT_GLYPHS = "█▒░▓■□◊·—0xACID303feedBAFC79";

function DecryptValue({
  value,
  delay,
  highlight,
}: {
  value: string;
  delay: number;
  /** Substring to highlight as the "acid signature" once decrypted */
  highlight?: string;
}) {
  const [revealed, setRevealed] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const startAt = performance.now() + delay * 1000;
    const perChar = 38;
    let raf = 0;
    const tick = (now: number) => {
      if (now < startAt) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const elapsed = now - startAt;
      const next = Math.min(value.length, Math.floor(elapsed / perChar));
      setRevealed(next);
      setCycle((c) => (c + 1) % 9999);
      if (next < value.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delay]);

  // Build the displayed string: revealed chars are real, rest are random glyphs
  let highlightStart = -1;
  let highlightEnd = -1;
  if (highlight) {
    highlightStart = value.indexOf(highlight);
    if (highlightStart >= 0) highlightEnd = highlightStart + highlight.length;
  }

  return (
    <span className="mc-decrypt-value">
      {value.split("").map((ch, i) => {
        const isRevealed = i < revealed;
        const display = isRevealed
          ? ch
          : DECRYPT_GLYPHS[(Math.abs(cycle * 31 + i * 17)) % DECRYPT_GLYPHS.length];
        const inHighlight = isRevealed && i >= highlightStart && i < highlightEnd;
        return (
          <span
            key={i}
            className={
              "mc-decrypt-ch" +
              (isRevealed ? " mc-decrypt-ch--ok" : " mc-decrypt-ch--glitch") +
              (inHighlight ? " mc-decrypt-ch--acid" : "")
            }
          >
            {display}
          </span>
        );
      })}
    </span>
  );
}

function DecryptLine({
  label,
  value,
  delay,
  highlight,
}: {
  label: string;
  value: string;
  delay: number;
  highlight?: string;
}) {
  return (
    <motion.div
      className="mc-decrypt-row"
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: delay * 0.6, duration: 0.25 }}
    >
      <span className="mc-decrypt-label">{label}</span>
      <span className="mc-decrypt-arrow">›</span>
      <DecryptValue value={value} delay={delay} highlight={highlight} />
    </motion.div>
  );
}

const ASCII_SMILEY = [
  "   ▄▄▄▄▄▄▄▄▄▄▄▄▄   ",
  "  ███████████████  ",
  " ██▀▀▀▀▀▀▀▀▀▀▀▀▀██ ",
  "██  ██▀▀█    █▀▀██ ██",
  "██  ██  █    █  ██ ██",
  "██  ▀▀▀▀█    █▀▀▀▀ ██",
  "██               ██",
  "██ █▄         ▄█ ██",
  " ██ ▀█▄▄▄▄▄▄▄█▀ ██ ",
  "  ███████████████  ",
  "   ▀▀▀▀▀▀▀▀▀▀▀▀▀   ",
];

function Act1({ txHash }: { txHash: string | null }) {
  const priceGho = formatUnits(VR303_PRICE_WEI, 18);
  const shortHash = txHash
    ? `${txHash.slice(0, 18)}...${txHash.slice(-8)}`
    : "0x" + "0".repeat(20) + "...";
  return (
    <motion.div
      key="act1"
      className="mc-act mc-act--1"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <pre className="mc-ascii-smiley">{ASCII_SMILEY.join("\n")}</pre>
      <div className="mc-act__tag">// DECRYPTING SIGNAL // 03 / 03 / LOCKED</div>
      <div className="mc-decrypt">
        <DecryptLine
          label="CONTRACT"
          value={CONTRACT}
          delay={0.2}
          highlight="303AC1D"
        />
        <DecryptLine
          label="ACTION"
          value={VR303_MINT_POST_ACTION}
          delay={1.3}
          highlight="303feeD"
        />
        <DecryptLine label="CHAIN" value="LENS // CHAIN 232" delay={2.5} highlight="232" />
        <DecryptLine label="SUPPLY" value="303 / 303" delay={3.2} highlight="303" />
        <DecryptLine label="PRICE" value={`${priceGho} GHO`} delay={3.9} />
        <DecryptLine label="TX" value={shortHash} delay={4.6} />
      </div>
      <div className="mc-act__hint mc-pulse">contract is the rave // 0x303_AC1D</div>
    </motion.div>
  );
}

function Act2({
  txHash,
  blockNumber,
  wallet,
}: {
  txHash: string | null;
  blockNumber: number | null;
  wallet: string;
}) {
  // Panel-wide rattle that intensifies as blocks confirm
  const intensity = blockNumber !== null ? Math.min(1, blockNumber / 6) : 0.3;
  return (
    <motion.div
      key="act2"
      className="mc-act mc-act--2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <motion.div
        className="mc-stamp-grid"
        animate={{
          x: [0, -2 * intensity, 2 * intensity, -1 * intensity, 1 * intensity, 0],
          rotate: [0, -0.3 * intensity, 0.3 * intensity, 0],
        }}
        transition={{ duration: 0.18, repeat: Infinity }}
      >
        <StampLine label="WALLET" value={`${wallet.slice(0, 8)}...${wallet.slice(-6)}`} delay={0} />
        <StampLine label="CHAIN" value="LENS // 232" delay={0.12} />
        <StampLine label="TX" value={txHash ? `${txHash.slice(0, 10)}...${txHash.slice(-6)}` : "pending..."} delay={0.24} />
        <StampLine
          label="BLOCK"
          value={blockNumber !== null ? `+${blockNumber}` : "waiting..."}
          delay={0.36}
          restampKey={blockNumber ?? -1}
        />
        <StampLine label="STATUS" value="STAMPING..." delay={0.48} accent restampKey={blockNumber ?? -1} />
      </motion.div>
      <div className="mc-act__hint mc-pulse">CONFIRMING // STAY ON THE FLOOR</div>
    </motion.div>
  );
}

function StampLine({
  label,
  value,
  delay,
  accent,
  restampKey,
}: {
  label: string;
  value: string;
  delay: number;
  accent?: boolean;
  restampKey?: number | string;
}) {
  // Bump key when restampKey changes → re-runs the entry animation
  const stampKey = `${label}-${restampKey ?? "static"}`;
  return (
    <motion.div
      key={stampKey}
      className={"mc-stamp" + (accent ? " mc-stamp--accent" : "")}
      initial={{ scale: 2.4, opacity: 0, rotate: -6, x: -10 }}
      animate={{
        scale: [2.4, 0.85, 1.08, 0.96, 1],
        opacity: [0, 1, 1, 1, 1],
        rotate: [-6, 3, -1, 0.5, 0],
        x: [-10, 4, -2, 1, 0],
      }}
      transition={{ delay, duration: 0.32, times: [0, 0.35, 0.6, 0.85, 1], ease: "easeOut" }}
    >
      <span className="mc-stamp__label">{label}</span>
      <span className="mc-stamp__value mc-glitch" data-text={value}>
        {value}
      </span>
    </motion.div>
  );
}

function Act3({ edition }: { edition: number }) {
  const artworkUrl = edition > 0 ? getVr303Artwork(edition - 1) : undefined;

  return (
    <motion.div
      key="act3"
      className="mc-act mc-act--3"
      initial={{ scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, type: "spring", stiffness: 240, damping: 14 }}
    >
      <div className="mc-drop-flash" />
      <motion.div
        className={artworkUrl ? "mc-drop-art" : "mc-drop-smiley"}
        initial={{ scale: 0, rotate: -180 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ duration: 0.6, type: "spring", stiffness: 200, damping: 12 }}
      >
        {artworkUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={artworkUrl} alt={`VR 303 edition ${edition}`} className="mc-drop-art__img" />
        ) : (
          <img src="/smiley/face.png" alt="" className="mc-smiley__face" />
        )}
      </motion.div>
      <div className="mc-drop-edition">
        <span className="mc-drop-edition__label">EDITION</span>
        <CountUp to={edition} />
        <span className="mc-drop-edition__total">/ 303</span>
      </div>
      <div className="mc-drop-tag">VR 303 // ARCHIVED // CC0</div>
    </motion.div>
  );
}

function CountUp({ to, duration = 1.2 }: { to: number; duration?: number }) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const p = Math.min(1, (now - start) / (duration * 1000));
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.floor(eased * to));
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);
  return <span className="mc-drop-edition__num">{String(val).padStart(3, "0")}</span>;
}

function InkTypedHash({ hash }: { hash: string }) {
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (!hash) return;
    const startAt = performance.now() + 700;
    const perChar = 24;
    let raf = 0;
    const tick = (now: number) => {
      if (now < startAt) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const elapsed = now - startAt;
      const next = Math.min(hash.length, Math.floor(elapsed / perChar));
      setRevealed(next);
      if (next < hash.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hash]);
  return (
    <span className="mc-ticket__hash">
      {hash.split("").map((ch, i) => (
        <span
          key={i}
          className={"mc-ticket__hash-ch" + (i < revealed ? " mc-ticket__hash-ch--inked" : "")}
        >
          {i < revealed ? ch : "·"}
        </span>
      ))}
    </span>
  );
}

function Act4Ticket({
  ctx,
  dragY,
  stubOpacity,
  tearAngle,
  onTearEnd,
  onClose,
}: {
  ctx: CeremonyContext;
  dragY: ReturnType<typeof useMotionValue<number>>;
  stubOpacity: ReturnType<typeof useTransform<number, number>>;
  tearAngle: ReturnType<typeof useTransform<number, number>>;
  onTearEnd: () => void;
  onClose: () => void;
}) {
  const mintedAt = ctx.mintedAt ? new Date(ctx.mintedAt) : new Date();
  const mintDate = mintedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const mintTime = mintedAt.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const editionStr = String(ctx.edition).padStart(3, "0");
  const artworkUrl = ctx.edition > 0 ? getVr303Artwork(ctx.edition - 1) : undefined;
  return (
    <motion.div
      key="act4"
      className="mc-act mc-act--4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <motion.div
        className="mc-welcome"
        initial={{ scale: 1.4, opacity: 0, y: -10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.4, type: "spring", stiffness: 220, damping: 16 }}
      >
        <span className="mc-welcome__pre">// you are now</span>
        <span className="mc-welcome__big mc-glitch" data-text="ON THE LIST">ON THE LIST</span>
        <span className="mc-welcome__post">
          {ctx.lensHandle ? `${ctx.lensHandle} ·` : "guest"} {editionStr} / 303
        </span>
      </motion.div>

      <motion.div
        className="mc-ticket"
        drag="y"
        dragConstraints={{ top: 0, bottom: 240 }}
        dragElastic={0.2}
        style={{ y: dragY, opacity: stubOpacity, rotate: tearAngle }}
        onDragEnd={onTearEnd}
        initial={{ scale: 0.7, opacity: 0, rotate: -8 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        transition={{ delay: 0.35, duration: 0.5, type: "spring", stiffness: 180, damping: 14 }}
      >
        {/* slam-in ADMITTED stamp */}
        <motion.div
          className="mc-ticket__admitted"
          initial={{ scale: 4, opacity: 0, rotate: -25 }}
          animate={{ scale: 1, opacity: 0.78, rotate: -12 }}
          transition={{ delay: 0.85, duration: 0.32, type: "spring", stiffness: 380, damping: 18 }}
        >
          ADMITTED
          <span className="mc-ticket__admitted-sub">// 0x303_AC1D</span>
        </motion.div>

        <div className="mc-ticket__perforation" />
        <div className="mc-ticket__head">
          <span>VIRTUAL RAVE ARCHIVE</span>
          <span>RPS-01</span>
        </div>

        <div className="mc-ticket__edition">
          {artworkUrl ? (
            <div className="mc-ticket__art">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={artworkUrl} alt={`VR 303 edition ${ctx.edition}`} />
              <span className="mc-ticket__art-chip">YOUR NFT</span>
            </div>
          ) : null}
          <div className="mc-ticket__edition-mark">
            <span className="mc-ticket__edition-slash">/</span>
            <span className="mc-ticket__edition-num">{editionStr}</span>
            <span className="mc-ticket__edition-slash">/</span>
          </div>
        </div>
        <div className="mc-ticket__edition-cap">edition · 303 / 303 supply</div>

        <div className="mc-ticket__body">
          {ctx.lensHandle || ctx.lensAddress ? (
            <>
              <TicketRow
                label="LENS"
                value={ctx.lensHandle ?? (ctx.lensAddress ? `${ctx.lensAddress.slice(0, 8)}...${ctx.lensAddress.slice(-6)}` : "")}
                mono
                accent
              />
              <TicketRow label="SIGNED BY" value={`${ctx.wallet.slice(0, 8)}...${ctx.wallet.slice(-6)}`} mono />
            </>
          ) : (
            <TicketRow label="GUEST" value={ctx.wallet} mono />
          )}
          <TicketRow label="CHAIN" value="LENS // 232" />
          <TicketRow label="BLOCK" value={ctx.blockNumber !== null ? `#${ctx.blockNumber}` : "—"} />
          <TicketRow label="DATE" value={`${mintDate}  ${mintTime}`} />
        </div>

        <div className="mc-ticket__hash-section">
          <div className="mc-ticket__hash-label">// receipt — inked on chain</div>
          {ctx.txHash ? (
            <InkTypedHash hash={ctx.txHash} />
          ) : (
            <span className="mc-ticket__hash">—</span>
          )}
        </div>

        <div className="mc-ticket__barcode">
          <img src="/assets/barcode.png" alt="" />
        </div>
        <div className="mc-ticket__signoff">
          welcome to the rave. see you on the dancefloor.
        </div>
        <div className="mc-ticket__tear-hint">
          ↓ drag to tear ↓
        </div>
      </motion.div>

      <div className="mc-act4-actions">
        {ctx.txHash && (
          <a
            className="mc-btn"
            href={`https://explorer.lens.xyz/tx/${ctx.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            VIEW ON LENSCAN
          </a>
        )}
        <button className="mc-btn mc-btn--ghost" onClick={onClose}>
          WE&apos;LL SEE YOU INSIDE
        </button>
      </div>
    </motion.div>
  );
}

function TicketRow({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={"mc-ticket__row" + (accent ? " mc-ticket__row--accent" : "")}>
      <span className="mc-ticket__label">{label}</span>
      <span
        className={
          "mc-ticket__value" +
          (mono ? " mc-ticket__value--mono" : "") +
          (accent ? " mc-ticket__value--accent" : "")
        }
      >
        {value}
      </span>
    </div>
  );
}

function ActError({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <motion.div
      key="actE"
      className="mc-act mc-act--err"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="mc-act__title mc-glitch" data-text="SIGNAL LOST">
        SIGNAL LOST
      </div>
      <div className="mc-act__sub">&gt; {message}</div>
      <button className="mc-btn" onClick={onClose}>
        TRY AGAIN
      </button>
    </motion.div>
  );
}

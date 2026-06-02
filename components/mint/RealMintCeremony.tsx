"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient, useWaitForTransactionReceipt } from "wagmi";
import { lensMainnet } from "@/lib/wagmi";
import { MintCeremony, type CeremonyAct, type CeremonyContext } from "./MintCeremony";
import type { OrbSession } from "../OrbLoginPanel";

export interface RealMintCeremonyProps {
  /** True from the moment the user passed all guards and we're about to broadcast. */
  open: boolean;
  /** Wagmi-connected wallet that signed. */
  wallet: string | null;
  /** Orb session (if any) — used to show Lens handle on the ticket. */
  orbSession: OrbSession | null;
  /** When the lens-profile lane is used, the recipient's lens-account address. */
  lensAddress: string | null;
  /** Tx hash returned by writeContract / dispatchLensResult / executePostAction. Null until broadcast. */
  txHash: `0x${string}` | null;
  /** Total minted after confirmation (from contract.totalClaimed). Used for edition number. */
  totalClaimedAfter: number | null;
  /** True if the broadcast itself failed (rejected, revert, etc). */
  errored: boolean;
  errorMessage: string | null;
  /** Rect of the CLAIM button at click-time, used for the eats-page FLIP. */
  buttonRect: DOMRect | null;
  /** Real chain stream (debug log entries from the parent). */
  liveLog?: string[];
  /** Dev-only receipt override for ceremony timing tests without spending GHO. */
  simulatedReceipt?: {
    ok: boolean;
    error?: boolean;
    blockNumber?: number | null;
  };
  /** Called when the user dismisses the ceremony (ticket tear or close). */
  onClose: () => void;
}

// Per-mint act timing (real-data driven, not scripted):
//
//   Act 0 BROADCASTING   while txHash is null and !errored
//   Act 1 DECRYPTING     for ~5.8s once we have a hash (decrypt animation length)
//   Act 2 CONFIRMING     while waiting for receipt, or until first 6 blocks if receipt is slow
//   Act 3 THE DROP       1 bar (1.79s) once receipt confirms — fires audio drop
//   Act 4 ADMITTED       until user dismisses
//   Act -1 SIGNAL LOST   if errored at any point
const ACT1_MIN_MS = 5800;
const ACT3_LEN_MS = 1790;

export function RealMintCeremony({
  open,
  wallet,
  orbSession,
  lensAddress,
  txHash,
  totalClaimedAfter,
  errored,
  errorMessage,
  buttonRect,
  liveLog,
  simulatedReceipt,
  onClose,
}: RealMintCeremonyProps) {
  const publicClient = usePublicClient({ chainId: lensMainnet.id });
  const [act, setAct] = useState<CeremonyAct>(0);
  const [latestBlock, setLatestBlock] = useState<number | null>(null);
  const [confirmBlocks, setConfirmBlocks] = useState<number | null>(null);
  const txHashSetAt = useRef<number | null>(null);
  const receiptHandledAt = useRef<number | null>(null);
  const dropTimerStarted = useRef(false);
  const wasOpenRef = useRef(false);

  const { data: chainReceipt, isSuccess: chainReceiptOk, isError: chainReceiptErr } =
    useWaitForTransactionReceipt({
      hash: txHash ?? undefined,
      chainId: lensMainnet.id,
      confirmations: 1,
    });
  const receipt = simulatedReceipt?.blockNumber
    ? { blockNumber: BigInt(simulatedReceipt.blockNumber) }
    : chainReceipt;
  const receiptOk = simulatedReceipt ? simulatedReceipt.ok : chainReceiptOk;
  const receiptErr = simulatedReceipt?.error ?? chainReceiptErr;

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setAct(txHash ? 1 : 0);
      setLatestBlock(null);
      setConfirmBlocks(null);
      txHashSetAt.current = txHash ? performance.now() : null;
      receiptHandledAt.current = null;
      dropTimerStarted.current = false;
    }
    wasOpenRef.current = open;
  }, [open, txHash]);

  // ---- Block-by-block telemetry while waiting for the receipt ----
  useEffect(() => {
    if (!open || !publicClient || !txHash || receiptOk) return;
    const unwatch = publicClient.watchBlockNumber({
      onBlockNumber: (n) => setLatestBlock(Number(n)),
      emitOnBegin: true,
    });
    return () => {
      try { unwatch(); } catch {}
    };
  }, [open, publicClient, txHash, receiptOk]);

  // ---- Track tx-hash arrival moment ----
  useEffect(() => {
    if (txHash && txHashSetAt.current === null) {
      txHashSetAt.current = performance.now();
    }
    if (!txHash) {
      txHashSetAt.current = null;
      receiptHandledAt.current = null;
      dropTimerStarted.current = false;
    }
  }, [txHash]);

  // ---- Confirmation block delta for stamp rattle ----
  useEffect(() => {
    if (!receipt) return;
    setConfirmBlocks(Number(receipt.blockNumber));
  }, [receipt]);

  // ---- Drive the act state machine from real signals ----
  useEffect(() => {
    if (!open) return;

    if (errored || receiptErr) {
      setAct(-1);
      return;
    }

    // Act 0: no hash yet, broadcasting
    if (!txHash) {
      setAct(0);
      return;
    }

    // Receipt confirmed → after Act 1 minimum elapsed, jump to Act 3 (drop)
    if (receiptOk) {
      if (dropTimerStarted.current) return;
      dropTimerStarted.current = true;

      const since = txHashSetAt.current ? performance.now() - txHashSetAt.current : 0;
      const minWait = ACT1_MIN_MS;
      if (receiptHandledAt.current === null) {
        receiptHandledAt.current = performance.now();
      }
      if (since < minWait) {
        // Race: receipt came in faster than our decrypt animation. Keep the
        // decrypt act visible long enough, then advance to the drop.
        const wait = minWait - since;
        setAct(1);
        let act4Id: number | null = null;
        const id = window.setTimeout(() => {
          setAct(3);
          act4Id = window.setTimeout(() => setAct(4), ACT3_LEN_MS);
        }, wait);
        return () => {
          window.clearTimeout(id);
          if (act4Id !== null) window.clearTimeout(act4Id);
        };
      }
      // Already past the minimum — go to drop now
      setAct(3);
      const id = window.setTimeout(() => setAct(4), ACT3_LEN_MS);
      return () => window.clearTimeout(id);
    }

    // We have a hash but no receipt yet. Spend ACT1_MIN_MS on decrypt, then sit in confirm.
    const since = txHashSetAt.current ? performance.now() - txHashSetAt.current : 0;
    if (since < ACT1_MIN_MS) {
      setAct(1);
      const id = window.setTimeout(() => setAct(2), ACT1_MIN_MS - since);
      return () => window.clearTimeout(id);
    }
    setAct(2);
  }, [open, txHash, receiptOk, receiptErr, errored]);

  // ---- Build context from real data ----
  const lensHandle = orbSession?.handle ?? null;

  // Block number passed to the ceremony: confirmed block once we have it, else live tip
  const liveBlock = confirmBlocks ?? latestBlock;

  // Edition: after-mint totalClaimed (refetched by parent), null until known
  const edition = totalClaimedAfter ?? 0;

  const ctx: CeremonyContext = useMemo(
    () => ({
      edition,
      wallet: wallet ?? "0x0000000000000000000000000000000000000000",
      lensHandle,
      lensAddress,
      txHash,
      blockNumber: liveBlock,
      mintedAt: null,
      errorMessage,
    }),
    [edition, wallet, lensHandle, lensAddress, txHash, liveBlock, errorMessage],
  );

  return (
    <MintCeremony
      open={open}
      act={act}
      ctx={ctx}
      buttonRect={buttonRect}
      onClose={onClose}
      liveLog={liveLog}
    />
  );
}

"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AnimatePresence } from "framer-motion";
import type { CollectorRecord, CollectorsResponse } from "@/lib/collectors";
import { CollectorTile } from "./CollectorTile";
import { CollectorModal } from "./CollectorModal";
import { MintCeremony, type CeremonyAct, type CeremonyContext } from "./mint/MintCeremony";
import type { OrbSession } from "./OrbLoginPanel";

interface CollectorsWallProps {
  mintTick?: number;
  orbSession: OrbSession | null;
  onConnect: () => void;
}

type Status = "idle" | "loading" | "success" | "error";

export function CollectorsWall({ mintTick = 0, orbSession, onConnect }: CollectorsWallProps) {
  const { address } = useAccount();
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<CollectorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [yoursOnly, setYoursOnly] = useState(false);
  const [active, setActive] = useState<CollectorRecord | null>(null);
  const [replay, setReplay] = useState<{
    record: CollectorRecord;
    buttonRect: DOMRect | null;
  } | null>(null);
  const [replayAct, setReplayAct] = useState<CeremonyAct>(0);
  const firstMount = useRef(true);
  const dataRef = useRef<CollectorsResponse | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const load = useCallback(async () => {
    setStatus((current) => (dataRef.current ? current : "loading"));
    try {
      const res = await fetch(`/api/collectors?ts=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as CollectorsResponse;
      setData(json);
      setStatus("success");
      setError(null);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch (fresh) on every mintTick change after first mount.
  useEffect(() => {
    if (firstMount.current) {
      firstMount.current = false;
      return;
    }
    void load();
  }, [mintTick, load]);

  const lowerAddress = address ? address.toLowerCase() : null;

  const yourTokenCount = useMemo(() => {
    if (!data || !lowerAddress) return 0;
    return data.collectors.filter((c) => c.owner.toLowerCase() === lowerAddress).length;
  }, [data, lowerAddress]);

  const visibleCollectors = useMemo(() => {
    if (!data) return [];
    if (!yoursOnly || !lowerAddress) return data.collectors;
    return data.collectors.filter((c) => c.owner.toLowerCase() === lowerAddress);
  }, [data, yoursOnly, lowerAddress]);

  const totalDisplay = data ? data.totalClaimed : "...";
  const showYoursDisabled = !address || yourTokenCount === 0;

  const ownerEq = (a: string, b: string | null) =>
    b !== null && a.toLowerCase() === b;

  const handleTransferComplete = useCallback((record: CollectorRecord, nextOwner: string) => {
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        collectors: current.collectors.map((collector) =>
          collector.tokenId === record.tokenId
            ? { ...collector, owner: nextOwner as CollectorRecord["owner"] }
            : collector,
        ),
      };
    });
    setActive((current) =>
      current?.tokenId === record.tokenId
        ? { ...current, owner: nextOwner as CollectorRecord["owner"] }
        : current,
    );
  }, []);

  useEffect(() => {
    if (!replay) return;

    setReplayAct(0);
    const decryptId = window.setTimeout(() => setReplayAct(1), 1200);
    const confirmId = window.setTimeout(() => setReplayAct(2), 7000);
    const dropId = window.setTimeout(() => setReplayAct(3), 9600);
    const ticketId = window.setTimeout(() => setReplayAct(4), 11400);

    return () => {
      window.clearTimeout(decryptId);
      window.clearTimeout(confirmId);
      window.clearTimeout(dropId);
      window.clearTimeout(ticketId);
    };
  }, [replay]);

  const replayCtx: CeremonyContext | null = replay
    ? {
        edition: replay.record.metadata?.edition ?? replay.record.tokenId + 1,
        wallet: replay.record.mint?.to ?? replay.record.owner,
        lensHandle: null,
        lensAddress: null,
        txHash: replay.record.mint?.transactionHash ?? null,
        blockNumber: replay.record.mint?.blockNumber ?? null,
        mintedAt: replay.record.mint?.mintedAt ?? null,
        errorMessage: null,
      }
    : null;

  return (
    <section id="collectors" className="cwall">
      <div className="cwall__head">
        <div>
          <div className="section-tag">
            <span className="square" /> SECTION  02 / COLLECTORS
          </div>
          <h2 className="section-title">
            the <em>wall</em>
          </h2>
        </div>
        <p className="section-blurb">
          Every VR 303 collected so far. Each tile is one edition, one collector.
        </p>
      </div>

      <div className="win cwall__win">
        <div className="win__bar">
          <div className="title">
            <span className="ico"></span> collectors_wall.sys  VR 303 //
            {" "}
            {typeof totalDisplay === "number"
              ? `${String(totalDisplay).padStart(3, "0")} of 303`
              : "... of 303"}
          </div>
          <div className="ctrls">
            <span className="ctrl">_</span>
            <span className="ctrl"></span>
            <span className="ctrl">x</span>
          </div>
        </div>

        <div className="win__body cwall__body">
          <div className="cwall__toolbar">
            <button
              type="button"
              className={`cwall__toggle${yoursOnly ? " is-active" : ""}`}
              disabled={showYoursDisabled}
              onClick={() => setYoursOnly((y) => !y)}
              title={
                !address
                  ? "Connect a wallet to see your editions"
                  : yourTokenCount === 0
                    ? "No editions for this wallet yet"
                    : `${yourTokenCount} edition${yourTokenCount === 1 ? "" : "s"} owned`
              }
            >
              {yoursOnly ? "[ ALL ]" : "[ YOURS ONLY ]"}
              <span className="cwall__toggle-sub">
                {address
                  ? yourTokenCount > 0
                    ? `${yourTokenCount} owned`
                    : "0 owned"
                  : "connect wallet"}
              </span>
            </button>

            {status === "error" ? (
              <button
                type="button"
                className="cwall__retry"
                onClick={() => void load()}
              >
                // signal lost — retry
              </button>
            ) : null}
          </div>

          {status === "loading" && !data ? (
            <div className="cwall__empty">// scanning chain...</div>
          ) : status === "error" && !data ? (
            <div className="cwall__empty cwall__empty--error">
              // signal lost {error ? `(${error})` : ""}
            </div>
          ) : visibleCollectors.length === 0 ? (
            <div className="cwall__empty">
              {yoursOnly
                ? "// no editions in this wallet"
                : "// awaiting first collectors"}
            </div>
          ) : (
            <div className="cwall__grid">
              {visibleCollectors.map((c) => (
                <CollectorTile
                  key={c.tokenId}
                  record={c}
                  isYours={ownerEq(c.owner, lowerAddress)}
                  onOpen={setActive}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {active ? (
          <CollectorModal
            record={active}
            isYours={ownerEq(active.owner, lowerAddress)}
            orbSession={orbSession}
            onConnect={onConnect}
            onReplay={(record, buttonRect) => setReplay({ record, buttonRect })}
            onTransferComplete={handleTransferComplete}
            onClose={() => setActive(null)}
          />
        ) : null}
      </AnimatePresence>

      {replay && replayCtx ? (
        <MintCeremony
          open
          act={replayAct}
          ctx={replayCtx}
          buttonRect={replay.buttonRect}
          onClose={() => setReplay(null)}
        />
      ) : null}
    </section>
  );
}

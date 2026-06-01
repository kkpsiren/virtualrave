"use client";
import { useState, useEffect, useRef } from "react";
import { RealMintCeremony } from "./mint/RealMintCeremony";
import {
  useAccount,
  useWaitForTransactionReceipt,
  useReadContract,
  useBalance,
  usePublicClient,
  useWriteContract,
  useSwitchChain,
} from "wagmi";
import { createPublicClient, getAddress, http, isAddress, type Address } from "viem";
import { mainnet as ethMainnet } from "viem/chains";
import { lensMainnet, CONTRACT } from "@/lib/wagmi";
import type { OrbSession } from "./OrbLoginPanel";
import { useWalletClient } from "wagmi";
import { dispatchOrbSponsoredTransaction, requestOrbBuyTransaction } from "@/lib/orbBuy";
import { getLensProfilePaymentReadiness } from "@/lib/claimAuthority.mjs";
import {
  formatGhoAmount,
  getNetMintCostWei,
  getGrossMintCostWei,
} from "@/lib/vr303Action";
import {
  ACTION_HUB_ABI,
  LENS_ACTION_HUB,
  buildDirectVr303ActionArgs,
} from "@/lib/directVr303Action";

function toDebugValue(value: unknown): unknown {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: toDebugValue(value.cause),
    };
  }
  if (Array.isArray(value)) return value.map(toDebugValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toDebugValue(item),
      ]),
    );
  }
  return value;
}

function debugStringify(value: unknown) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(toDebugValue(value), null, 2);
  } catch {
    return String(value);
  }
}

function friendlyClaimError(raw: string) {
  if (raw.includes("0xc84651bb")) {
    return "Direct collect is inactive on the contract.";
  }
  if (raw.includes("0x77a5352e")) {
    return "Lens action is rejecting this collect path.";
  }
  if (raw.toLowerCase().includes("payment-enabled manager")) {
    return "Connect the Lens profile owner or a payment-enabled manager wallet.";
  }
  if (raw.toLowerCase().includes("expired auth")) {
    return "Reconnect Orb to prepare profile collect.";
  }
  if (raw.toLowerCase().includes("authenticated signer does not match")) {
    return "Connected wallet does not match the Orb authenticated signer.";
  }
  if (raw.toLowerCase().includes("orb buy")) {
    return raw.slice(0, 100) || "Orb buy route failed.";
  }
  return raw.slice(0, 100) || "TX FAILED. TRY AGAIN";
}

const SUPPLY_ABI = [
  {
    name: "totalClaimed",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const CLAIM_ABI = [
  {
    name: "claim",
    type: "function",
    inputs: [
      { name: "quantity", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

const CONTRACT_STATUS_ABI = [
  {
    name: "globalMintEnabled",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    name: "paused",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

function ProgressBar({
  minted,
  total,
  segments = 40,
}: {
  minted: number;
  total: number;
  segments?: number;
}) {
  const filled = Math.round((minted / total) * segments);
  return (
    <div className="progress">
      {Array.from({ length: segments }, (_, i) => {
        const on = i < filled;
        const last = i === filled - 1;
        return (
          <span
            key={i}
            className={`seg${on ? " on" : ""}${last ? " last" : ""}`}
          />
        );
      })}
    </div>
  );
}

function TerminalLog({ entries }: { entries: string[] }) {
  const [open, setOpen] = useState(false);
  const [typedLatest, setTypedLatest] = useState("");
  const latest = entries[entries.length - 1] ?? "";
  const previous = entries.slice(0, -1);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!latest) {
      setTypedLatest("");
      return;
    }
    const headerEnd = latest.indexOf("\n");
    const headerLen = headerEnd === -1 ? latest.length : headerEnd;
    setTypedLatest("");
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      if (i >= headerLen) {
        setTypedLatest(latest);
        window.clearInterval(id);
        return;
      }
      setTypedLatest(latest.slice(0, i));
    }, 18);
    return () => window.clearInterval(id);
  }, [latest]);

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [open, typedLatest, entries.length]);

  if (entries.length === 0) return null;

  return (
    <div className="tlog">
      <div className="tlog__head">
        <span className="tlog__title">
          <span className="tlog__dot" />
          terminal_log.sys  {entries.length} line{entries.length === 1 ? "" : "s"}
        </span>
        <button type="button" className="tlog__toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "[ − ] collapse" : "[ + ] expand"}
        </button>
      </div>
      <div
        ref={bodyRef}
        className={"tlog__body" + (open ? " tlog__body--open" : "")}
      >
        {open
          ? previous.map((line, i) => (
              <span key={i} className="tlog__line">
                <span className="tlog__prefix">&gt;</span>
                {line}
              </span>
            ))
          : null}
        {latest ? (
          <span className="tlog__line tlog__line--latest">
            <span className="tlog__prefix">&gt;</span>
            {typedLatest}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface ClaimTerminalProps {
  onConnect: () => void;
  orbSession: OrbSession | null;
  onMintSuccess?: () => void;
}

type MintDestination = "orb" | "wallet" | "custom";
type PaymentSource = "lensProfile" | "eoa";
type CustomResolveStatus = "idle" | "resolving" | "resolved" | "error";
type ClaimExecutionMode = "directContract" | "directLensAction" | "orbSponsoredAction";

type LensManagerPermissions = {
  canExecuteTransactions: boolean;
  canTransferTokens: boolean;
  canTransferNative: boolean;
  canSetMetadataUri?: boolean;
};

type ProfileAuthorityState = {
  status: "idle" | "loading" | "ready" | "error";
  ownerAddress: Address | null;
  managerPermissions: LensManagerPermissions | null;
  error: string | null;
};

const ensClient = createPublicClient({
  chain: ethMainnet,
  transport: http(),
});

function getOrbWalletAddress(session: OrbSession | null): Address | null {
  const candidate = session?.userId ?? session?.account;
  return candidate && isAddress(candidate) ? getAddress(candidate) : null;
}

function normalizeOptionalAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

export function ClaimTerminal({ onConnect, orbSession, onMintSuccess }: ClaimTerminalProps) {
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: lensMainnet.id });
  const publicClient = usePublicClient({ chainId: lensMainnet.id });
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const [qty, setQty] = useState(1);
  const [mintDestination, setMintDestination] = useState<MintDestination>(
    orbSession ? "orb" : "wallet",
  );
  const [customRecipient, setCustomRecipient] = useState("");
  const [customRecipientAddress, setCustomRecipientAddress] = useState<Address | null>(null);
  const [customResolveStatus, setCustomResolveStatus] = useState<CustomResolveStatus>("idle");
  const [profileAuthority, setProfileAuthority] = useState<ProfileAuthorityState>({
    status: "idle",
    ownerAddress: null,
    managerPermissions: null,
    error: null,
  });
  const [txStatus, setTxStatus] = useState<"idle" | "busy" | "success" | "error">("idle");
  const [step, setStep] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  // Mint ceremony — opens at broadcast, drives off real chain state
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [ceremonyRect, setCeremonyRect] = useState<DOMRect | null>(null);
  const [ceremonyError, setCeremonyError] = useState<string | null>(null);
  const [totalClaimedAfter, setTotalClaimedAfter] = useState<number | null>(null);
  const claimButtonRef = useRef<HTMLButtonElement | null>(null);
  const mintSuccessNotifiedRef = useRef(false);
  const total = 303;
  const orbWalletAddress = getOrbWalletAddress(orbSession);
  const lensProfileCostWei = getGrossMintCostWei(qty);
  const eoaCostWei = getNetMintCostWei(qty);

  const { data: supplyRaw, refetch: refetchSupply } = useReadContract({
    address: CONTRACT,
    abi: SUPPLY_ABI,
    functionName: "totalClaimed",
    chainId: lensMainnet.id,
    query: { refetchInterval: 15_000 },
  });
  const { data: globalMintEnabled } = useReadContract({
    address: CONTRACT,
    abi: CONTRACT_STATUS_ABI,
    functionName: "globalMintEnabled",
    chainId: lensMainnet.id,
    query: { refetchInterval: 15_000 },
  });
  const { data: contractPaused } = useReadContract({
    address: CONTRACT,
    abi: CONTRACT_STATUS_ABI,
    functionName: "paused",
    chainId: lensMainnet.id,
    query: { refetchInterval: 15_000 },
  });

  const minted = supplyRaw !== undefined ? Number(supplyRaw) : null;
  const { data: payerBalance } = useBalance({
    address,
    chainId: lensMainnet.id,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const { data: orbBalance } = useBalance({
    address: orbWalletAddress ?? undefined,
    chainId: lensMainnet.id,
    query: { enabled: Boolean(orbWalletAddress), refetchInterval: 15_000 },
  });
  const lensProfilePaymentReadiness = getLensProfilePaymentReadiness({
    profileAddress: orbWalletAddress,
    ownerAddress: profileAuthority.ownerAddress,
    connectedAddress: address,
    managerPermissions: profileAuthority.managerPermissions,
    balanceWei: orbBalance?.value,
    requiredWei: lensProfileCostWei,
    isAuthorityLoading: profileAuthority.status === "loading",
  });
  const canUseLensProfilePayment =
    mintDestination !== "wallet" && lensProfilePaymentReadiness.canPay;
  const paymentSource: PaymentSource = canUseLensProfilePayment ? "lensProfile" : "eoa";
  const executionMode: ClaimExecutionMode =
    mintDestination === "wallet"
      ? "directContract"
      : canUseLensProfilePayment
        ? "orbSponsoredAction"
        : "directLensAction";
  const estimatedCostWei = executionMode === "directContract" ? eoaCostWei : lensProfileCostWei;
  const needsOrb = mintDestination === "orb" || paymentSource === "lensProfile";
  const paymentBalance = paymentSource === "lensProfile" ? orbBalance : payerBalance;
  const paymentAddress = paymentSource === "lensProfile" ? orbWalletAddress : address;
  const hasEnoughGho = paymentBalance ? paymentBalance.value >= estimatedCostWei : true;

  const { isSuccess: txConfirmed } = useWaitForTransactionReceipt({
    hash: txHash ?? undefined,
  });

  function appendDebug(label: string, details?: unknown) {
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    const body = debugStringify(details);
    const entry = body ? `${stamp}  ${label}\n${body}` : `${stamp}  ${label}`;
    setDebugLog((log) => [...log.slice(-39), entry]);
    // eslint-disable-next-line no-console
    console.debug(`[vr303] ${label}`, details ?? "");
  }

  useEffect(() => {
    if (txConfirmed) {
      appendDebug("transaction receipt confirmed", { txHash });
      refetchSupply().then((r) => {
        const v = r.data;
        if (v !== undefined) {
          // After mint: totalClaimed includes this user's edition(s).
          // Their personal edition number is the new total (last claimed slot).
          setTotalClaimedAfter(Number(v));
        }
      });
      setTxStatus("success");
      setStep(txHash ? `${txHash.slice(0, 10)}...${txHash.slice(-6)}` : "confirmed");
      if (txHash) {
        (async () => {
          try {
            const res = await fetch("/api/collectors/refresh", {
              method: "POST",
              cache: "no-store",
            });
            const body = await res.json().catch(() => null);
            appendDebug("collectors/refresh response", { status: res.status, body });
          } catch (err) {
            appendDebug("collectors/refresh failed", toDebugValue(err));
          } finally {
            onMintSuccess?.();
          }
        })();
      } else {
        onMintSuccess?.();
      }
      if (!mintSuccessNotifiedRef.current) mintSuccessNotifiedRef.current = true;
    }
  }, [txConfirmed, txHash, refetchSupply, onMintSuccess]);

  useEffect(() => {
    if (!orbWalletAddress && mintDestination === "orb") {
      setMintDestination("wallet");
    }
  }, [mintDestination, orbWalletAddress]);

  useEffect(() => {
    if (!orbWalletAddress || !address) {
      setProfileAuthority({
        status: "idle",
        ownerAddress: null,
        managerPermissions: null,
        error: null,
      });
      return;
    }

    let cancelled = false;
    setProfileAuthority({
      status: "loading",
      ownerAddress: null,
      managerPermissions: null,
      error: null,
    });

    const params = new URLSearchParams({
      account: orbWalletAddress,
      manager: address,
    });

    fetch(`/api/lens/account-authority?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as unknown;
        if (!response.ok || !payload || typeof payload !== "object") {
          throw new Error("Lens authority lookup failed.");
        }
        return payload as Record<string, unknown>;
      })
      .then((payload) => {
        if (cancelled) return;
        const permissions =
          payload.managerPermissions &&
          typeof payload.managerPermissions === "object" &&
          !Array.isArray(payload.managerPermissions)
            ? (payload.managerPermissions as LensManagerPermissions)
            : null;
        setProfileAuthority({
          status: "ready",
          ownerAddress: normalizeOptionalAddress(payload.ownerAddress),
          managerPermissions: permissions,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProfileAuthority({
          status: "error",
          ownerAddress: null,
          managerPermissions: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [orbWalletAddress, address]);

  useEffect(() => {
    const value = customRecipient.trim();

    if (!value) {
      setCustomRecipientAddress(null);
      setCustomResolveStatus("idle");
      return;
    }

    if (isAddress(value)) {
      setCustomRecipientAddress(getAddress(value));
      setCustomResolveStatus("resolved");
      return;
    }

    let cancelled = false;
    setCustomRecipientAddress(null);
    setCustomResolveStatus("resolving");

    ensClient
      .getEnsAddress({ name: value })
      .then((resolved) => {
        if (cancelled) return;
        if (resolved) {
          setCustomRecipientAddress(getAddress(resolved));
          setCustomResolveStatus("resolved");
        } else {
          setCustomRecipientAddress(null);
          setCustomResolveStatus("error");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setCustomRecipientAddress(null);
        setCustomResolveStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [customRecipient]);

  const handleClaim = async () => {
    setDebugLog([]);
    appendDebug("collect clicked", {
      qty,
      mintDestination,
      paymentSource,
      executionMode,
      lensChainId: lensMainnet.id,
      connectedChainId: chainId ?? null,
      connectedWallet: address ?? null,
      isConnected,
      hasWalletClient: Boolean(walletClient),
      orbSession: orbSession
        ? {
            account: orbSession.account,
            userId: orbSession.userId,
            handle: orbSession.handle,
            authenticationId: orbSession.authenticationId,
            hasAccessToken: Boolean(orbSession.accessToken),
            processed: orbSession.processed,
            status: orbSession.status,
          }
        : null,
      orbWalletAddress,
      profilePaymentAuthority: {
        lookupStatus: profileAuthority.status,
        ownerAddress: profileAuthority.ownerAddress,
        managerPermissions: profileAuthority.managerPermissions,
        readiness: lensProfilePaymentReadiness,
        lookupError: profileAuthority.error,
      },
      connectedWalletBalanceWei: payerBalance?.value,
      connectedWalletBalanceFormatted: payerBalance?.formatted,
      orbWalletBalanceWei: orbBalance?.value,
      orbWalletBalanceFormatted: orbBalance?.formatted,
      paymentAddress,
      paymentBalanceWei: paymentBalance?.value,
      paymentBalanceFormatted: paymentBalance?.formatted,
      customRecipient,
      customRecipientAddress,
      customResolveStatus,
      globalMintEnabled,
      contractPaused,
      estimatedCostWei,
      estimatedCostFormatted: formatGhoAmount(estimatedCostWei),
      hasEnoughGho,
    });

    if (needsOrb && !orbSession) {
      appendDebug("blocked: missing Orb session, opening connect modal");
      onConnect();
      return;
    }
    if (mintDestination === "custom" && !customRecipientAddress) {
      setTxStatus("error");
      setStep(customResolveStatus === "resolving" ? "Resolving recipient..." : "Enter a valid wallet or ENS.");
      appendDebug("blocked: custom recipient unresolved", {
        customRecipient,
        customResolveStatus,
      });
      return;
    }
    if (!isConnected || !address) {
      appendDebug("blocked: missing connected wallet, opening connect modal", {
        paymentSource,
        isConnected,
        connectedWallet: address ?? null,
        hasWalletClient: Boolean(walletClient),
      });
      onConnect();
      return;
    }
    if (chainId !== lensMainnet.id) {
      setTxStatus("busy");
      setStep("SWITCH TO LENS...");
      appendDebug("connected wallet is on the wrong chain, requesting Lens switch", {
        paymentSource,
        connectedChainId: chainId ?? null,
        requiredChainId: lensMainnet.id,
        hasWalletClient: Boolean(walletClient),
      });
      try {
        await switchChainAsync({ chainId: lensMainnet.id });
        appendDebug("Lens chain switch requested successfully");
        setTxStatus("idle");
        setStep("Lens network ready. Claim again.");
      } catch (err) {
        setTxStatus("error");
        setStep("Switch wallet to Lens network.");
        appendDebug("Lens chain switch failed", toDebugValue(err));
      }
      return;
    }
    if (paymentSource === "lensProfile" && !orbWalletAddress) {
      setTxStatus("error");
      setStep("Reconnect Orb to collect with Lens profile.");
      appendDebug("blocked: missing Lens profile account address", {
        orbSession: orbSession
          ? {
              account: orbSession.account,
              userId: orbSession.userId,
              handle: orbSession.handle,
              authenticationId: orbSession.authenticationId,
              hasAccessToken: Boolean(orbSession.accessToken),
              processed: orbSession.processed,
              status: orbSession.status,
            }
          : null,
        orbWalletAddress,
      });
      onConnect();
      return;
    }
    if (paymentSource === "lensProfile" && !orbSession?.accessToken) {
      setTxStatus("error");
      setStep("Reconnect Orb to prepare profile collect.");
      appendDebug("blocked: missing Orb access token for buy route", {
        lensAccount: orbWalletAddress,
        signer: address,
      });
      onConnect();
      return;
    }
    if (txStatus === "busy") {
      appendDebug("blocked: transaction already busy", { step });
      return;
    }
    if (globalMintEnabled === false) {
      setTxStatus("error");
      setStep("Collect is globally disabled on the contract.");
      appendDebug("blocked: globalMintEnabled is false", {
        contract: CONTRACT,
        globalMintEnabled,
        contractPaused,
        hint: "Owner must call setGlobalMintEnabled(true) before direct collects or Lens actions can collect.",
      });
      return;
    }
    if (contractPaused) {
      setTxStatus("error");
      setStep("Contract is paused.");
      appendDebug("blocked: contract is paused", {
        contract: CONTRACT,
        globalMintEnabled,
        contractPaused,
      });
      return;
    }
    if (paymentBalance && !hasEnoughGho) {
      setTxStatus("error");
      setStep(`Need at least ${formatGhoAmount(eoaCostWei)} GHO on Lens.`);
      appendDebug("blocked: payer balance too low", {
        paymentSource,
        paymentAddress,
        paymentBalanceWei: paymentBalance.value,
        paymentBalanceFormatted: paymentBalance.formatted,
        connectedWallet: address,
        connectedWalletBalanceWei: payerBalance?.value,
        connectedWalletBalanceFormatted: payerBalance?.formatted,
        orbWalletAddress,
        orbWalletBalanceWei: orbBalance?.value,
        orbWalletBalanceFormatted: orbBalance?.formatted,
        requiredWei: estimatedCostWei,
        requiredFormatted: formatGhoAmount(estimatedCostWei),
      });
      return;
    }

    setTxStatus("busy");
    setStep("BUILDING ACTION...");
    setTxHash(null);

    // === MINT CEREMONY OPENS HERE ===
    // The moment we commit to broadcasting, the ceremony takes over the page.
    // Act 0 (BROADCASTING) holds until txHash is set; downstream acts are driven
    // by real chain state via RealMintCeremony.
    setCeremonyError(null);
    setTotalClaimedAfter(null);
    setCeremonyRect(claimButtonRef.current?.getBoundingClientRect() ?? null);
    setCeremonyOpen(true);

    try {
      if (executionMode === "directContract") {
        setStep("SIGN WITH EOA...");
        appendDebug("dispatching direct EOA contract collect", {
          contract: CONTRACT,
          payer: address,
          receiver: address,
          quantity: qty,
          valueWei: eoaCostWei,
          valueFormatted: formatGhoAmount(eoaCostWei),
        });
        if (publicClient && address) {
          await publicClient.estimateContractGas({
            address: CONTRACT,
            abi: CLAIM_ABI,
            functionName: "claim",
            args: [BigInt(qty), []],
            account: address,
            value: eoaCostWei,
          });
          appendDebug("direct EOA collect gas preflight passed");
        }
        const hash = await writeContractAsync({
          address: CONTRACT,
          abi: CLAIM_ABI,
          functionName: "claim",
          args: [BigInt(qty), []],
          value: eoaCostWei,
          chainId: lensMainnet.id,
          gas: BigInt(300_000),
        });
        appendDebug("direct EOA contract collect returned tx hash", { hash });
        setTxHash(hash);
        setStep("WAITING FOR CONFIRMATION...");
        return;
      }

      if (executionMode === "directLensAction") {
        const receiver = mintDestination === "custom" ? customRecipientAddress : orbWalletAddress;
        if (!receiver) {
          throw new Error("Collect receiver is missing.");
        }

        const args = buildDirectVr303ActionArgs({
          quantity: qty,
          receiver,
        });

        setStep("SIGN LENS ACTION...");
        appendDebug("dispatching direct EOA Lens action collect", {
          actionHub: LENS_ACTION_HUB,
          payer: address,
          receiver,
          quantity: qty,
          valueWei: estimatedCostWei,
          valueFormatted: formatGhoAmount(estimatedCostWei),
          reason:
            mintDestination === "orb"
              ? "Lens profile receives, connected wallet pays because profile payment authority is unavailable."
              : "Custom recipient receives, connected wallet pays.",
          profilePaymentAuthority: {
            lookupStatus: profileAuthority.status,
            readiness: lensProfilePaymentReadiness,
          },
        });

        let gas: bigint | undefined;
        if (publicClient && address) {
          const estimatedGas = await publicClient.estimateContractGas({
            address: LENS_ACTION_HUB,
            abi: ACTION_HUB_ABI,
            functionName: "executePostAction",
            args,
            account: address,
            value: estimatedCostWei,
          });
          gas = estimatedGas + estimatedGas / 5n;
          appendDebug("direct EOA Lens action gas preflight passed", {
            estimatedGas,
            gasWithBuffer: gas,
          });
        }

        const hash = await writeContractAsync({
          address: LENS_ACTION_HUB,
          abi: ACTION_HUB_ABI,
          functionName: "executePostAction",
          args,
          value: estimatedCostWei,
          chainId: lensMainnet.id,
          ...(gas ? { gas } : {}),
        });
        appendDebug("direct EOA Lens action returned tx hash", { hash });
        setTxHash(hash);
        setStep("WAITING FOR CONFIRMATION...");
        return;
      }

      appendDebug("building receiver", {
        mintDestination,
        paymentSource,
        orbWalletAddress,
        connectedWallet: address,
        customRecipient,
        customRecipientAddress,
      });
      const profileAccount = orbWalletAddress;
      if (!profileAccount) {
        throw new Error("Lens profile account is missing for Orb buy.");
      }
      const receiver = mintDestination === "custom" ? customRecipientAddress : null;

      appendDebug("requesting Orb buy transaction", {
        account: profileAccount,
        signer: address,
        receiver,
        quantity: qty,
        paymentSource,
        hasAccessToken: Boolean(orbSession?.accessToken),
      });

      if (!walletClient) {
        appendDebug("blocked: Orb buy transaction needs connected wallet signature", {
          isConnected,
          connectedWallet: address,
        });
        setTxStatus("error");
        setStep("Connect the admin/controller wallet to sign this collect.");
        onConnect();
        return;
      }

      setStep("REQUESTING SPONSORED TX...");
      const buy = await requestOrbBuyTransaction({
        account: profileAccount,
        signer: address,
        quantity: qty,
        receiver,
        accessToken: orbSession?.accessToken,
      });
      appendDebug("Orb buy transaction response", {
        status: buy.payload.status,
        data: {
          ...buy.payload.data,
          transactions: buy.payload.data.transactions.map((tx: unknown) =>
            typeof tx === "object" && tx !== null
              ? {
                  to: (tx as { to?: unknown }).to,
                  chainId: (tx as { chainId?: unknown }).chainId,
                  amount: (tx as { amount?: unknown }).amount,
                  gasLimit: (tx as { gasLimit?: unknown }).gasLimit,
                  nonce: (tx as { nonce?: unknown }).nonce,
                  hasPaymaster: Boolean(
                    (tx as { paymaster?: unknown }).paymaster &&
                      (tx as { paymasterInput?: unknown }).paymasterInput,
                  ),
                }
              : tx,
          ),
        },
      });
      setStep("SIGN SPONSORED COLLECT...");
      const hash = await dispatchOrbSponsoredTransaction(buy.transaction, walletClient);
      appendDebug("wallet dispatch returned tx hash", { hash });
      setTxHash(hash);
      setStep("WAITING FOR CONFIRMATION...");
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const lower = raw.toLowerCase();
      const rejected = lower.includes("rejected") || lower.includes("denied") || lower.includes("cancel") || lower.includes("user rejected");
      appendDebug("collect failed", {
        raw,
        rejected,
        error: toDebugValue(err),
      });
      if (rejected) {
        setTxStatus("idle");
        setStep("");
        // User rejected the signature — close the ceremony, no signal-lost screen needed
        setCeremonyOpen(false);
      } else {
        setTxStatus("error");
        const msg = friendlyClaimError(raw);
        setStep(msg);
        setCeremonyError(msg);
      }
    }
  };

  const reset = () => {
    setTxStatus("idle");
    setStep("");
    setQty(1);
    setDebugLog([]);
    mintSuccessNotifiedRef.current = false;
  };

  const walletDisplay = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : null;
  const orbDisplay = orbWalletAddress
    ? `${orbWalletAddress.slice(0, 8)}...${orbWalletAddress.slice(-6)}`
    : orbSession?.account
    ? `${orbSession.account.slice(0, 8)}...${orbSession.account.slice(-6)}`
    : orbSession?.authenticationId
      ? `${orbSession.authenticationId.slice(0, 8)}...${orbSession.authenticationId.slice(-6)}`
      : null;
  const recipientDisplay =
    mintDestination === "orb" && orbDisplay
      ? orbDisplay
      : mintDestination === "custom"
        ? customRecipientAddress
          ? `${customRecipientAddress.slice(0, 6)}...${customRecipientAddress.slice(-4)}`
          : customRecipient.trim() || "paste wallet or ENS"
        : walletDisplay || "connect wallet";
  const destinationLabel =
    mintDestination === "orb"
      ? "LENS PROFILE"
      : mintDestination === "custom"
        ? "CUSTOM WALLET"
        : "CONNECTED WALLET";
  const claimLaneLabel = executionMode === "directContract" ? "DIRECT EOA" : "LENS ACTION";
  const mintUnavailable = globalMintEnabled === false || contractPaused === true;
  const customHint =
    customResolveStatus === "resolved"
      ? customRecipientAddress
        ? `${customRecipientAddress.slice(0, 6)}...${customRecipientAddress.slice(-4)}`
        : "resolved"
      : customResolveStatus === "resolving"
        ? "resolving..."
        : customResolveStatus === "error"
          ? "not found"
          : "0x or ENS";
  const mintedDisplay = minted !== null ? minted : "...";
  const pctDisplay = minted !== null ? ((minted / total) * 100).toFixed(1) : "0.0";
  const visibleCostDisplay = formatGhoAmount(eoaCostWei);

  return (
    <div className="win">
      <div className="win__bar">
        <div className="title">
          <span className="ico"></span> collect_terminal.exe  VR 303
        </div>
        <div className="ctrls">
          <span className="ctrl">_</span>
          <span className="ctrl"></span>
          <span className="ctrl">x</span>
        </div>
      </div>
      <div className="win__body">
        <div className="claim__counter">
          <div>
            <div className="label">COLLECTED / SUPPLY</div>
            <div className="big">
              {String(mintedDisplay).padStart(3, "0")}
              <span className="of"> / {total}</span>
            </div>
          </div>
          <div style={{ alignSelf: "stretch", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
            <ProgressBar minted={minted ?? 0} total={total} />
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="label">% COLLECTED</div>
            <div className="big">
              {pctDisplay}
              <span style={{ fontSize: 22 }}>%</span>
            </div>
          </div>
        </div>

        <div className="field">
          <label>
            <span>// ORB LOGIN</span>
            <span className="hint">{orbSession ? "LENS PROFILE READY" : "CONNECT LENS PROFILE"}</span>
          </label>
          <div className="input">
            <input value={orbDisplay || "login with orb to load your lens profile"} readOnly suppressHydrationWarning />
            <button className="suffix" onClick={onConnect}>
              {orbSession ? "ORB OK" : "ORB LOGIN"}
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            <span>// COLLECT WALLET</span>
            <span className="hint">{isConnected ? "EOA SIGNER" : "NOT CONNECTED"}</span>
          </label>
          <div className="input">
            <input value={walletDisplay || "0x... connect a wallet to fill this in"} readOnly suppressHydrationWarning />
            <button className="suffix" onClick={onConnect}>
              {isConnected ? "CHANGE" : "CONNECT"}
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            <span>// COLLECT DESTINATION</span>
            <span className="hint">{recipientDisplay}</span>
          </label>
          <div className="dest-toggle">
            <button
              type="button"
              className={mintDestination === "orb" ? "is-active" : ""}
              disabled={!orbWalletAddress}
              onClick={() => setMintDestination("orb")}
            >
              LENS PROFILE
              <span>{orbBalance ? `${orbBalance.formatted} GHO` : orbDisplay || "unavailable"}</span>
            </button>
            <button
              type="button"
              className={mintDestination === "wallet" ? "is-active" : ""}
              onClick={() => setMintDestination("wallet")}
            >
              CONNECTED WALLET
              <span>{payerBalance ? `${payerBalance.formatted} GHO` : walletDisplay || "after connect"}</span>
            </button>
            <button
              type="button"
              className={mintDestination === "custom" ? "is-active" : ""}
              onClick={() => setMintDestination("custom")}
            >
              CUSTOM WALLET
              <span>{customHint}</span>
            </button>
          </div>
        </div>

        {mintDestination === "custom" ? (
          <div className="field">
            <label>
              <span>// CUSTOM RECIPIENT</span>
              <span className="hint">{customHint}</span>
            </label>
            <div className="input">
              <input
                value={customRecipient}
                onChange={(event) => setCustomRecipient(event.target.value)}
                placeholder="0x... or vitalik.eth"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                suppressHydrationWarning
              />
              <button className="suffix" type="button" onClick={() => setCustomRecipient("")}>
                CLEAR
              </button>
            </div>
          </div>
        ) : null}

        <div className="claim__row2">
          <div className="claim__qty-wrap">
            <label className="claim__sublabel">// QUANTITY</label>
            <div className="qty">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1}>-</button>
              <div className="val">{String(qty).padStart(2, "0")}</div>
              <button onClick={() => setQty((q) => Math.min(303, q + 1))} disabled={qty >= 303}>+</button>
            </div>
          </div>
          <div className="claim__price-wrap">
            <label className="claim__sublabel">// EST. TOTAL</label>
            <div className="price-card">
              <div className="k">{claimLaneLabel}</div>
              <div><span className="v">{visibleCostDisplay} GHO</span></div>
            </div>
          </div>
        </div>

        {txStatus === "success" ? (
          <button
            className="btn-claim is-success"
            onClick={() => {
              setCeremonyRect(null);
              setCeremonyError(null);
              setCeremonyOpen(true);
            }}
            disabled={!txHash}
          >
            <span>REPLAY MINT CEREMONY</span>
            <span className="arr"></span>
          </button>
        ) : (
          <button
            ref={claimButtonRef}
            className={`btn-claim${txStatus === "busy" ? " is-busy" : ""}`}
            onClick={handleClaim}
            disabled={txStatus === "busy" || mintUnavailable}
          >
            <span>
              {txStatus === "busy"
                ? step
                : globalMintEnabled === false
                ? "COLLECT DISABLED ON CONTRACT"
                : contractPaused
                ? "CONTRACT PAUSED"
                : needsOrb && !orbSession
                ? "LOGIN WITH ORB TO COLLECT"
                : !isConnected
                ? "CONNECT WALLET TO COLLECT"
                : `COLLECT VR 303 x 0${qty} TO ${destinationLabel}`}
              <span className="mini" style={{ display: "block" }}>
                {txStatus === "busy"
                  ? "DO NOT CLOSE THIS WINDOW..."
                  : globalMintEnabled === false
                  ? "OWNER MUST ENABLE COLLECTING"
                  : contractPaused
                  ? "OWNER MUST UNPAUSE THE CONTRACT"
                  : needsOrb && !orbSession
                  ? "SCAN QR WITH ORB  THEN SIGN WITH WALLET"
                  : !isConnected
                  ? "CONNECT A WALLET ON LENS MAINNET"
                  : `${visibleCostDisplay} GHO  DESTINATION ${recipientDisplay}`}
              </span>
            </span>
            <span className="arr">{txStatus === "busy" ? "..." : ""}</span>
          </button>
        )}

        <div className="claim__notes">
          {txStatus === "success" ? (
            <>
              <div className="li">TX HASH  <strong>{step}</strong></div>
              <div className="li">YOUR VR 303 IS ON LENS. THE FINALE SHOWS YOUR MINTED ART.</div>
              <div className="li">CHECK LENSCAN, OPENSEA, OR FAMILY.</div>
              <button type="button" className="claim__note-btn" onClick={reset}>
                COLLECT ANOTHER
              </button>
            </>
          ) : txStatus === "error" ? (
            <>
              <div className="li" style={{ color: "red" }}>{step}</div>
              <div className="li">Selected destination: {destinationLabel} {recipientDisplay}. Check GHO, Lens permissions, and try again.</div>
            </>
          ) : (
            <>
              <div className="li">Send to Lens profile through Orb, or send to connected wallet with direct collect.</div>
              <div className="li">Collect stops at 303 of 303 editions.</div>
              <div className="li">On-chain renderer. CC0 license.</div>
            </>
          )}
        </div>

        <TerminalLog entries={debugLog} />
      </div>

      <RealMintCeremony
        open={ceremonyOpen}
        wallet={address ?? null}
        orbSession={orbSession}
        lensAddress={
          mintDestination === "custom"
            ? customRecipientAddress
            : mintDestination === "orb"
              ? orbWalletAddress
              : null
        }
        txHash={txHash}
        totalClaimedAfter={totalClaimedAfter}
        errored={txStatus === "error"}
        errorMessage={ceremonyError}
        buttonRect={ceremonyRect}
        liveLog={debugLog}
        onClose={() => {
          setCeremonyOpen(false);
          // If the user dismisses after a success, that's their session ending — reset
          if (txStatus === "success" || txStatus === "error") {
            // keep success notes visible but allow them to mint again
            setCeremonyError(null);
          }
        }}
      />
    </div>
  );
}

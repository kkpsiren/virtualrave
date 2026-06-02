import { promises as fs } from "node:fs";
import path from "node:path";
import { createPublicClient, decodeEventLog, http, parseAbiItem, zeroAddress, type Address } from "viem";
import { lensServerChain, SERVER_CONTRACT } from "@/lib/lensChain";
import { VR303_DEPLOY_BLOCK } from "@/lib/vr303Constants";

export type CollectorAttribute = {
  trait_type: string;
  value: string;
};

export type CollectorMetadata = {
  dna: string;
  name: string;
  description: string;
  image: string;
  edition: number;
  date: number;
  attributes: CollectorAttribute[];
  compiler: string;
};

export type CollectorMintReceipt = {
  chainId: number;
  contract: Address;
  tokenId: number;
  edition: number;
  transactionHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  transactionIndex: number;
  logIndex: number;
  from: Address;
  to: Address;
  mintedAt: number;
  mintedAtIso: string;
};

export type CollectorRecord = {
  tokenId: number;
  owner: Address;
  mint?: CollectorMintReceipt;
  metadata?: CollectorMetadata;
};

export type CollectorsResponse = {
  collectors: CollectorRecord[];
  totalClaimed: number;
  fetchedAt: number | null;
};

const DATA_FILE = path.join(process.cwd(), "data", "collectors.json");
const TRAITS_FILE = path.join(process.cwd(), "data", "traits-metadata.json");
const LEGACY_METADATA_FILE = path.join(process.cwd(), "data", "collectors-metadata.json");
const MAX_SUPPLY = 303;

const OWNER_OF_ABI = [
  {
    name: "ownerOf",
    type: "function",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const TOTAL_CLAIMED_ABI = [
  {
    name: "totalClaimed",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

function rpcUrl(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (key) return `https://lens-mainnet.g.alchemy.com/v2/${key}`;
  return lensServerChain.rpcUrls.default.http[0];
}

function makeClient() {
  return createPublicClient({ chain: lensServerChain, transport: http(rpcUrl()) });
}

function parseJsonFile(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function readJson(): Promise<CollectorsResponse & { seeded: boolean }> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const parsed = parseJsonFile(raw) as Partial<CollectorsResponse> & { seeded?: boolean };
    return {
      collectors: parsed.collectors ?? [],
      totalClaimed: parsed.totalClaimed ?? 0,
      fetchedAt: parsed.fetchedAt ?? null,
      seeded: parsed.seeded ?? false,
    };
  } catch {
    return { collectors: [], totalClaimed: 0, fetchedAt: null, seeded: false };
  }
}

function isCollectorMetadata(item: unknown): item is CollectorMetadata {
  const candidate = item as Partial<CollectorMetadata> | null;
  return Boolean(
    candidate &&
      typeof candidate.edition === "number" &&
      typeof candidate.name === "string" &&
      typeof candidate.description === "string" &&
      typeof candidate.image === "string" &&
      typeof candidate.dna === "string" &&
      typeof candidate.date === "number" &&
      Array.isArray(candidate.attributes) &&
      typeof candidate.compiler === "string",
  );
}

function isCollectorMintReceipt(item: unknown): item is CollectorMintReceipt {
  const candidate = item as Partial<CollectorMintReceipt> | null;
  return Boolean(
    candidate &&
      typeof candidate.chainId === "number" &&
      typeof candidate.contract === "string" &&
      typeof candidate.tokenId === "number" &&
      typeof candidate.edition === "number" &&
      typeof candidate.transactionHash === "string" &&
      typeof candidate.blockNumber === "number" &&
      typeof candidate.blockHash === "string" &&
      typeof candidate.transactionIndex === "number" &&
      typeof candidate.logIndex === "number" &&
      typeof candidate.from === "string" &&
      typeof candidate.to === "string" &&
      typeof candidate.mintedAt === "number" &&
      typeof candidate.mintedAtIso === "string",
  );
}

function ingestMetadataPayload(parsed: unknown, metadataByEdition: Map<number, CollectorMetadata>) {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isCollectorMetadata(item)) metadataByEdition.set(item.edition, item);
    }
    return;
  }

  if (!parsed || typeof parsed !== "object") return;
  const tokens = (parsed as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) return;

  for (const token of tokens) {
    if (!token || typeof token !== "object") continue;
    const candidate = token as { tokenId?: unknown; metadata?: unknown };
    if (typeof candidate.tokenId !== "number") continue;
    if (!isCollectorMetadata(candidate.metadata)) continue;
    metadataByEdition.set(candidate.tokenId, candidate.metadata);
  }
}

async function readMetadataJson(): Promise<Map<number, CollectorMetadata>> {
  const metadataByEdition = new Map<number, CollectorMetadata>();
  for (const file of [TRAITS_FILE, LEGACY_METADATA_FILE]) {
    try {
      const raw = await fs.readFile(file, "utf-8");
      ingestMetadataPayload(parseJsonFile(raw), metadataByEdition);
    } catch {
      // ignore missing or malformed metadata files
    }
  }
  return metadataByEdition;
}

async function writeJson(state: CollectorsResponse & { seeded: boolean }) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function enrichCollectors(
  collectors: CollectorRecord[],
  metadataByEdition: Map<number, CollectorMetadata>,
): CollectorRecord[] {
  return collectors.map((record) => ({
    ...record,
    metadata: metadataByEdition.get(record.tokenId + 1),
  }));
}

function normalizeCollectors(collectors: CollectorRecord[]): CollectorRecord[] {
  const byToken = new Map<number, CollectorRecord>();
  for (const record of collectors) {
    if (!Number.isInteger(record.tokenId) || record.tokenId < 0 || record.tokenId > MAX_SUPPLY) continue;
    byToken.set(record.tokenId, {
      tokenId: record.tokenId,
      owner: record.owner,
      ...(isCollectorMintReceipt(record.mint) ? { mint: record.mint } : {}),
    });
  }
  return [...byToken.values()].sort((a, b) => a.tokenId - b.tokenId);
}

async function readMintReceiptsFromTransferLogs(
  client: ReturnType<typeof makeClient>,
): Promise<Map<number, CollectorMintReceipt>> {
  const logs = await client.getLogs({
    address: SERVER_CONTRACT,
    event: TRANSFER_EVENT,
    fromBlock: VR303_DEPLOY_BLOCK,
    toBlock: "latest",
  });

  const mintLogs = logs.filter(
    (log) => log.args.from?.toLowerCase() === zeroAddress && log.args.tokenId !== undefined && log.args.to,
  );
  const blockTimestamps = new Map<bigint, number>();
  const receipts = new Map<number, CollectorMintReceipt>();

  for (const log of mintLogs) {
    if (!blockTimestamps.has(log.blockNumber)) {
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      blockTimestamps.set(log.blockNumber, Number(block.timestamp) * 1000);
    }
    const mintedAt = blockTimestamps.get(log.blockNumber) ?? 0;
    const tokenId = Number(log.args.tokenId);
    receipts.set(tokenId, {
      chainId: lensServerChain.id,
      contract: SERVER_CONTRACT,
      tokenId,
      edition: tokenId + 1,
      transactionHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      from: log.args.from as Address,
      to: log.args.to as Address,
      mintedAt,
      mintedAtIso: new Date(mintedAt).toISOString(),
    });
  }

  return receipts;
}

async function scanAllOwners(): Promise<CollectorRecord[]> {
  const client = makeClient();
  const ids = Array.from({ length: MAX_SUPPLY }, (_, i) => i);
  const BATCH = 25;
  const collectors: CollectorRecord[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (tokenId) => {
        try {
          const owner = await client.readContract({
            address: SERVER_CONTRACT,
            abi: OWNER_OF_ABI,
            functionName: "ownerOf",
            args: [BigInt(tokenId)],
          });
          return { tokenId, owner: owner as Address };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) collectors.push(r);
  }
  return collectors;
}

async function readTotalClaimed(client: ReturnType<typeof makeClient>) {
  const value = await client.readContract({
    address: SERVER_CONTRACT,
    abi: TOTAL_CLAIMED_ABI,
    functionName: "totalClaimed",
  });
  return Math.min(Number(value), MAX_SUPPLY);
}

async function readCollectorsFromTransferLogs(): Promise<CollectorRecord[]> {
  const client = makeClient();
  const logs = await client.getLogs({
    address: SERVER_CONTRACT,
    event: TRANSFER_EVENT,
    fromBlock: VR303_DEPLOY_BLOCK,
    toBlock: "latest",
  });

  const ownersByToken = new Map<number, Address>();
  for (const log of logs) {
    const tokenId = log.args.tokenId !== undefined ? Number(log.args.tokenId) : null;
    const to = log.args.to;
    if (tokenId === null || !to) continue;
    if (to.toLowerCase() === zeroAddress) {
      ownersByToken.delete(tokenId);
    } else {
      ownersByToken.set(tokenId, to as Address);
    }
  }

  return normalizeCollectors(
    [...ownersByToken.entries()].map(([tokenId, owner]) => ({ tokenId, owner })),
  );
}

async function rebuildAndPersist(): Promise<CollectorsResponse> {
  const collectors = await scanAllOwners();
  const mintReceipts = await readMintReceiptsFromTransferLogs(makeClient());
  const state = {
    collectors: normalizeCollectors(
      collectors.map((collector) => ({
        ...collector,
        mint: mintReceipts.get(collector.tokenId),
      })),
    ),
    totalClaimed: collectors.length,
    fetchedAt: Date.now(),
    seeded: true,
  };
  await writeJson(state);
  const metadataByEdition = await readMetadataJson();
  return {
    collectors: enrichCollectors(state.collectors, metadataByEdition),
    totalClaimed: state.totalClaimed,
    fetchedAt: state.fetchedAt,
  };
}

export async function readCollectors(): Promise<CollectorsResponse> {
  const state = await readJson();
  const metadataByEdition = await readMetadataJson();
  const collectors = normalizeCollectors(state.collectors);
  return {
    collectors: enrichCollectors(collectors, metadataByEdition),
    totalClaimed: state.totalClaimed || collectors.length,
    fetchedAt: state.fetchedAt,
  };
}

export async function refreshFromChain(): Promise<CollectorsResponse> {
  const client = makeClient();
  const totalClaimed = await readTotalClaimed(client);
  const mintReceipts = await readMintReceiptsFromTransferLogs(client);
  const ids = Array.from({ length: totalClaimed }, (_, i) => i);
  const BATCH = 25;
  const collectors: CollectorRecord[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (tokenId) => {
        try {
          const owner = await client.readContract({
            address: SERVER_CONTRACT,
            abi: OWNER_OF_ABI,
            functionName: "ownerOf",
            args: [BigInt(tokenId)],
          });
          return { tokenId, owner: owner as Address };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) collectors.push(r);
  }
  const normalized = normalizeCollectors(collectors);
  const nextState = {
    collectors: normalized.map((collector) => ({
      ...collector,
      mint: mintReceipts.get(collector.tokenId),
    })),
    totalClaimed,
    fetchedAt: Date.now(),
    seeded: true,
  };
  await writeJson(nextState);

  const metadataByEdition = await readMetadataJson();
  return {
    collectors: enrichCollectors(normalized, metadataByEdition),
    totalClaimed,
    fetchedAt: nextState.fetchedAt,
  };
}

export async function recordTransferFromReceipt(
  txHash: `0x${string}`,
  expectedTokenId: number,
): Promise<CollectorsResponse> {
  const client = makeClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  let nextOwner: Address | null = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== SERVER_CONTRACT.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics,
      });
      const tokenId = Number(decoded.args.tokenId);
      if (tokenId !== expectedTokenId) continue;
      const to = decoded.args.to as Address | undefined;
      if (!to || to.toLowerCase() === zeroAddress) continue;
      nextOwner = to;
    } catch {
      // Ignore non-Transfer logs from the same transaction.
    }
  }

  if (!nextOwner) {
    throw new Error(`No VR303 Transfer log found for token ${expectedTokenId} in ${txHash}`);
  }

  const state = await readJson();
  const collectors = normalizeCollectors(state.collectors).map((collector) =>
    collector.tokenId === expectedTokenId
      ? { ...collector, owner: nextOwner }
      : collector,
  );
  const nextState = {
    collectors,
    totalClaimed: state.totalClaimed || collectors.length,
    fetchedAt: Date.now(),
    seeded: true,
  };
  await writeJson(nextState);

  const metadataByEdition = await readMetadataJson();
  return {
    collectors: enrichCollectors(collectors, metadataByEdition),
    totalClaimed: nextState.totalClaimed,
    fetchedAt: nextState.fetchedAt,
  };
}

// Back-compat aliases for existing callers.
export async function fetchMintLogs(): Promise<CollectorsResponse> {
  return readCollectors();
}
export async function appendMintFromReceipt(): Promise<CollectorsResponse> {
  return refreshFromChain();
}

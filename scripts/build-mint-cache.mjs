import fs from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbiItem, zeroAddress } from "viem";
import { chainConfig } from "viem/zksync";

const chain = {
  ...chainConfig,
  id: 232,
  name: "Lens",
  nativeCurrency: { name: "GHO", symbol: "GHO", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.lens.xyz"] } },
};

const CONTRACT = "0x303AC1D2736C70A9BaE4FC46aAe1c6Ed41C629Af";
const DATA_PATH = path.resolve("data/collectors.json");
const DEPLOY_BLOCK = /^\d+$/.test(process.env.NEXT_PUBLIC_VR303_DEPLOY_BLOCK ?? "")
  ? BigInt(process.env.NEXT_PUBLIC_VR303_DEPLOY_BLOCK)
  : 1n;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

function rpcUrl() {
  const key = process.env.ALCHEMY_API_KEY;
  return key ? `https://lens-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.lens.xyz";
}

function parseJson(raw) {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function readCollectors() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed.collectors)) {
    throw new Error("data/collectors.json is missing collectors[]");
  }
  return parsed;
}

async function main() {
  const state = await readCollectors();
  const client = createPublicClient({ chain, transport: http(rpcUrl()) });
  const logs = await client.getLogs({
    address: CONTRACT,
    event: transferEvent,
    fromBlock: DEPLOY_BLOCK,
    toBlock: "latest",
  });

  const mintLogs = logs.filter(
    (log) =>
      log.args.from?.toLowerCase() === zeroAddress &&
      log.args.tokenId !== undefined &&
      log.args.to,
  );
  const blockTimestamps = new Map();
  const receipts = new Map();

  for (const log of mintLogs) {
    if (!blockTimestamps.has(log.blockNumber)) {
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      blockTimestamps.set(log.blockNumber, Number(block.timestamp) * 1000);
    }

    const tokenId = Number(log.args.tokenId);
    const mintedAt = blockTimestamps.get(log.blockNumber) ?? 0;
    receipts.set(tokenId, {
      chainId: chain.id,
      contract: CONTRACT,
      tokenId,
      edition: tokenId + 1,
      transactionHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      blockHash: log.blockHash,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      from: log.args.from,
      to: log.args.to,
      mintedAt,
      mintedAtIso: new Date(mintedAt).toISOString(),
    });
  }

  state.collectors = state.collectors
    .map((collector) => ({
      ...collector,
      mint: receipts.get(collector.tokenId) ?? collector.mint,
    }))
    .sort((a, b) => a.tokenId - b.tokenId);
  state.totalClaimed = state.collectors.length;
  state.fetchedAt = Date.now();
  state.seeded = true;

  await fs.writeFile(DATA_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  console.log(`Cached ${receipts.size} mint receipts into ${DATA_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

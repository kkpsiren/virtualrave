import { NextResponse } from "next/server";
import { isHex } from "viem";
import { recordTransferFromReceipt } from "@/lib/collectors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { txHash?: unknown; tokenId?: unknown };
    const txHash = typeof body.txHash === "string" && isHex(body.txHash)
      ? body.txHash
      : null;
    const tokenId = typeof body.tokenId === "number" && Number.isInteger(body.tokenId)
      ? body.tokenId
      : null;

    if (!txHash || tokenId === null) {
      return NextResponse.json({ error: "Expected txHash and tokenId." }, { status: 400 });
    }

    const result = await recordTransferFromReceipt(txHash, tokenId);
    return NextResponse.json(result, {
      headers: {
        "x-vr303-cache": "record-transfer",
        "cache-control": "no-store, max-age=0, must-revalidate",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/collectors/record-transfer] failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

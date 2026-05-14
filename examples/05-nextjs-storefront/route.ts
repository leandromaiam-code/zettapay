/**
 * app/api/payments/[reference]/status/route.ts
 */

import { NextResponse } from "next/server";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { findReference } from "@solana/pay";

export async function GET(
  _req: Request,
  { params }: { params: { reference: string } },
): Promise<Response> {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  try {
    const sig = await findReference(connection, new PublicKey(params.reference), {
      finality: "confirmed",
    });
    return NextResponse.json({ confirmed: true, signature: sig.signature });
  } catch {
    return NextResponse.json({ confirmed: false });
  }
}

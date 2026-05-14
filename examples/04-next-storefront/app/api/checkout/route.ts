import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { amount, reference } = await req.json();
  const apiKey = process.env.ZETTAPAY_API_KEY!;
  const apiBase = process.env.ZETTAPAY_API_BASE ?? "https://api.zettapay.dev";

  const res = await fetch(`${apiBase}/v1/pay/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ amount, currency: "USDC", chain: "solana", reference }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: await res.text() }, { status: res.status });
  }
  const intent = await res.json();
  return NextResponse.json({ id: intent.id, uri: intent.uri, recipient: intent.recipient });
}

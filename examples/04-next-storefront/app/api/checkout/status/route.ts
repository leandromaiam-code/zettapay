import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const apiKey = process.env.ZETTAPAY_API_KEY!;
  const apiBase = process.env.ZETTAPAY_API_BASE ?? "https://api.zettapay.dev";

  const res = await fetch(`${apiBase}/v1/pay/${id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return NextResponse.json({ status: "unknown" }, { status: 502 });
  const body = await res.json();
  return NextResponse.json({ status: body.status, signature: body.signature ?? null });
}

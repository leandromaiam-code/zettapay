"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

type Intent = { id: string; uri: string; recipient: string };

export default function Checkout({ amount, reference }: { amount: string; reference: string }) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");

  async function start() {
    setStatus("creating");
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, reference }),
    });
    const data = (await res.json()) as Intent;
    setIntent(data);
    setQr(await QRCode.toDataURL(data.uri));
    setStatus("awaiting payment");
  }

  useEffect(() => {
    if (!intent) return;
    const apiBase = process.env.NEXT_PUBLIC_ZETTAPAY_API_BASE ?? "https://api.zettapay.dev";
    const handle = setInterval(async () => {
      const res = await fetch(`/api/checkout/status?id=${intent.id}`);
      if (!res.ok) return;
      const { status: s } = await res.json();
      setStatus(s);
      if (s === "settled" || s === "expired") clearInterval(handle);
    }, 3000);
    return () => clearInterval(handle);
  }, [intent]);

  if (!intent) {
    return (
      <button
        onClick={start}
        style={{ padding: "12px 24px", fontSize: 16, cursor: "pointer" }}
      >
        Pay {amount} USDC
      </button>
    );
  }

  return (
    <div>
      {qr && <img src={qr} alt="Solana Pay QR" width={256} height={256} />}
      <p>
        Send <b>{amount} USDC</b> to <code>{intent.recipient}</code>
      </p>
      <p>Status: {status}</p>
    </div>
  );
}

/**
 * Single-page React app embedding @zettapay/embed.
 */

import { useEffect, useRef, useState } from "react";
import { mountZettaPayEmbed } from "@zettapay/embed";

type Status = "pending" | "paid";

export default function App(): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>("pending");
  const [signature, setSignature] = useState<string>("");

  useEffect(() => {
    if (!ref.current) return;
    const handle = mountZettaPayEmbed(ref.current, {
      amount: "9.99",
      currency: "USDC",
      reference: crypto.randomUUID(),
      apiBaseUrl: import.meta.env.VITE_ZETTAPAY_API ?? "https://zettapay.vercel.app",
      onPaid: ({ signature: sig }) => {
        setStatus("paid");
        setSignature(sig);
      },
    });
    return () => handle.destroy();
  }, []);

  return (
    <main style={{
      fontFamily: "Manrope, sans-serif",
      color: "#f5e6c8",
      background: "#0a1612",
      minHeight: "100vh",
      padding: 32,
    }}>
      <h1 style={{ fontFamily: "Cormorant Garamond, serif" }}>Pay 9.99 USDC</h1>
      <div ref={ref} />
      {status === "paid" && (
        <p style={{ color: "#d4a961", fontFamily: "JetBrains Mono, monospace" }}>
          ✓ confirmed · {signature.slice(0, 12)}…
        </p>
      )}
    </main>
  );
}

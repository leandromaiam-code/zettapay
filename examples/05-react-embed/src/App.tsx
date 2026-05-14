import { useState } from "react";
import { ZettaCheckout } from "./ZettaCheckout";

export default function App() {
  const merchantId = import.meta.env.VITE_ZETTAPAY_MERCHANT_ID as string;
  const [settled, setSettled] = useState<{ intentId: string; signature: string } | null>(null);

  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 640 }}>
      <h1>Buy this cool thing</h1>
      <p>One cool thing — 12 USDC.</p>
      <ZettaCheckout
        merchantId={merchantId}
        amount="12.00"
        currency="USD"
        reference={`react-demo-${Date.now()}`}
        onSettled={setSettled}
      />
      {settled && (
        <p style={{ color: "green" }}>
          Paid · <code>{settled.signature.slice(0, 16)}…</code>
        </p>
      )}
    </main>
  );
}

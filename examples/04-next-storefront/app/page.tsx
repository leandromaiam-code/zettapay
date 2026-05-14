import Checkout from "./components/checkout";

export default function ProductPage() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 48, maxWidth: 720 }}>
      <h1>Zettapay Coffee · 1lb roasted beans</h1>
      <p>Single-origin, USDC-only checkout.</p>
      <Checkout amount="18.00" reference={`order-${Date.now()}`} />
    </main>
  );
}

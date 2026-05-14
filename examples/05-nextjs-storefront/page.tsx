/**
 * app/shop/[sku]/page.tsx — server component, no client wallet code.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { encodeURL } from "@solana/pay";
import BigNumber from "bignumber.js";
import qrcode from "qrcode";

const USDC_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

type ShopProps = { params: { sku: string } };

const CATALOG: Record<string, { price: string; title: string }> = {
  "book-001": { price: "9.99", title: "The Wallet-Less Guide to Solana Pay" },
  "tee-042": { price: "24.00", title: "Veridian Forest Tee" },
};

export default async function Page({ params }: ShopProps): Promise<JSX.Element> {
  const product = CATALOG[params.sku];
  if (!product) return <p>not found</p>;

  const merchant = new PublicKey(process.env.MERCHANT_PUBKEY ?? "11111111111111111111111111111111");
  const reference = Keypair.generate().publicKey;
  const url = encodeURL({
    recipient: merchant,
    amount: new BigNumber(product.price),
    splToken: USDC_DEVNET,
    reference,
    label: "Veridian Storefront",
    message: product.title,
  });
  const qrPng = await qrcode.toDataURL(url.toString(), { width: 384 });

  return (
    <main style={{ padding: 32, fontFamily: "Manrope, sans-serif", color: "#f5e6c8", background: "#0a1612", minHeight: "100vh" }}>
      <h1 style={{ fontFamily: "Cormorant Garamond, serif", fontSize: 40 }}>{product.title}</h1>
      <p>Pay {product.price} USDC</p>
      <img src={qrPng} alt="payment QR" width={384} height={384} />
      <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#d4a961" }}>
        ref · {reference.toBase58()}
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            const ref = ${JSON.stringify(reference.toBase58())};
            const poll = setInterval(async () => {
              const r = await fetch('/api/payments/' + ref + '/status');
              const j = await r.json();
              if (j.confirmed) { clearInterval(poll); document.title = 'paid'; location.reload(); }
            }, 2000);
          `,
        }}
      />
    </main>
  );
}

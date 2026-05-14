import { useEffect, useRef } from "react";

type Props = {
  merchantId: string;
  amount: string;
  currency?: string;
  reference?: string;
  onSettled?: (detail: { intentId: string; signature: string }) => void;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "zetta-checkout": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "data-merchant-id"?: string;
          "data-amount"?: string;
          "data-currency"?: string;
          "data-reference"?: string;
        },
        HTMLElement
      >;
    }
  }
}

export function ZettaCheckout({ merchantId, amount, currency = "USD", reference, onSettled }: Props) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onSettled) return;
    const handler = (e: Event) => onSettled((e as CustomEvent).detail);
    el.addEventListener("zettapay:settled", handler);
    return () => el.removeEventListener("zettapay:settled", handler);
  }, [onSettled]);

  return (
    <zetta-checkout
      ref={ref as React.Ref<HTMLElement>}
      data-merchant-id={merchantId}
      data-amount={amount}
      data-currency={currency}
      data-reference={reference}
    />
  );
}

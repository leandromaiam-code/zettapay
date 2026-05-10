/**
 * Helpers for the generic WordPress (non-Woo) plugin onboarding endpoints.
 *
 * The plugin lives at `plugins/wordpress-zettapay/`. Unlike WooCommerce there
 * is no payment gateway integration — the merchant just drops a shortcode
 * (`[zettapay merchant="merch_xxx" amount="10.00"]`) onto a page. The API
 * needs to expose two things:
 *
 *  1. A static metadata document (slug + version + install steps) the
 *     dashboard renders as install instructions.
 *  2. A merchant-scoped snippet builder that pre-fills the shortcode with the
 *     correct id and a sample amount, ready to be copy-pasted.
 */

const PLUGIN_SLUG = "zettapay-wordpress";

export interface RenderShortcodeSnippetInput {
  merchantId: string;
  merchantName: string;
  /** Sample amount baked into the snippet. Caller may pass an empty string to omit. */
  sampleAmount?: string;
  /** Default currency baked into the snippet (defaults to USDC). */
  currency?: string;
}

/**
 * Build the human-friendly snippet a merchant copy-pastes into a WordPress
 * page or post. Output is plain text (not JSON-encoded) — the dashboard
 * wraps it in a copy-to-clipboard control.
 *
 * Both `merchantId` and `merchantName` are sanitized so the snippet can be
 * embedded in HTML without further escaping if the dashboard chooses to.
 */
export function renderWordPressShortcode(input: RenderShortcodeSnippetInput): string {
  const merchantId = sanitizeShortcodeAttr(input.merchantId);
  const merchantName = sanitizeShortcodeAttr(input.merchantName);
  const currency = sanitizeShortcodeAttr(input.currency ?? "USDC") || "USDC";
  const amount = sanitizeAmount(input.sampleAmount ?? "");
  const lines = [
    `<!-- ZettaPay · ${merchantName} (${merchantId}) -->`,
    amount
      ? `[zettapay merchant="${merchantId}" amount="${amount}" currency="${currency}"]`
      : `[zettapay merchant="${merchantId}" currency="${currency}"]`,
  ];
  return lines.join("\n");
}

export const WORDPRESS_PLUGIN_SLUG = PLUGIN_SLUG;

/**
 * Conservative shortcode-attr sanitizer — strips characters that would break
 * out of a `"..."` attribute or look like markup. We also strip `[` and `]`
 * because they would terminate the shortcode early on the WordPress side.
 */
function sanitizeShortcodeAttr(value: string): string {
  return String(value ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/["'<>\[\]\\]/g, "")
    .trim()
    .slice(0, 120);
}

function sanitizeAmount(value: string): string {
  const v = String(value ?? "").trim();
  if (v === "") return "";
  return /^\d+(?:\.\d{1,8})?$/.test(v) ? v : "";
}

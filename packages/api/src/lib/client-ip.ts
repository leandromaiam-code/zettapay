import type { Request } from "express";

const TRUSTED_PROXY_HEADER = "x-forwarded-for";

/** Resolves the originating client IP from a request, honoring the
 * X-Forwarded-For chain (first hop wins) and falling back to the socket
 * remote address. Returns `null` when nothing usable is present. */
export function extractClientIp(req: Request): string | null {
  const fwd = req.header(TRUSTED_PROXY_HEADER);
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const direct = req.ip ?? req.socket?.remoteAddress;
  return direct && direct.length > 0 ? direct : null;
}

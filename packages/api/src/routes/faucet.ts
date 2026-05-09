import { Router, type Request, type Response } from "express";
import { PublicKey } from "@solana/web3.js";
import {
  FaucetLimitError,
  FaucetUnavailableError,
  requestAirdrop,
} from "../lib/faucet.js";
import type { SolanaConnectionService } from "../lib/solana.js";

interface FaucetBody {
  recipient?: unknown;
  lamports?: unknown;
}

export function faucetRouter(
  service: SolanaConnectionService,
  maxLamports: number,
): Router {
  const router = Router();

  router.post("/airdrop", async (req: Request<unknown, unknown, FaucetBody>, res: Response) => {
    const recipient = typeof req.body?.recipient === "string" ? req.body.recipient : null;
    if (!recipient) {
      res.status(400).json({ error: "recipient (base58 pubkey) is required" });
      return;
    }
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(recipient);
    } catch {
      res.status(400).json({ error: `invalid recipient pubkey: ${recipient}` });
      return;
    }

    const lamportsRaw = req.body?.lamports;
    const lamports =
      typeof lamportsRaw === "number"
        ? lamportsRaw
        : typeof lamportsRaw === "string"
          ? Number.parseInt(lamportsRaw, 10)
          : undefined;
    if (lamports !== undefined && (!Number.isFinite(lamports) || lamports <= 0)) {
      res.status(400).json({ error: `invalid lamports: ${String(lamportsRaw)}` });
      return;
    }

    try {
      const result = await requestAirdrop(service, pubkey, { lamports, maxLamports });
      res.json(result);
    } catch (error) {
      if (error instanceof FaucetUnavailableError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof FaucetLimitError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).json({ error: `airdrop failed: ${message}` });
    }
  });

  return router;
}

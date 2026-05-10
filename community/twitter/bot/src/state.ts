import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BotState {
  /** Highest TPV threshold (USDC) we have already announced. */
  lastTpvThresholdUsdc: number;
  /** Highest merchant count we have already announced (announce on every new). */
  lastMerchantCount: number;
  /** ISO timestamp of the last weekly digest tweet. */
  lastWeeklyDigestAt: string | null;
  /** Set of merchant IDs already shouted out, capped to MAX_RECENT_MERCHANTS. */
  announcedMerchantIds: string[];
}

const MAX_RECENT_MERCHANTS = 500;

const EMPTY: BotState = {
  lastTpvThresholdUsdc: 0,
  lastMerchantCount: 0,
  lastWeeklyDigestAt: null,
  announcedMerchantIds: [],
};

export async function load(file: string): Promise<BotState> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return {
      lastTpvThresholdUsdc: Number(parsed.lastTpvThresholdUsdc ?? 0),
      lastMerchantCount: Number(parsed.lastMerchantCount ?? 0),
      lastWeeklyDigestAt: parsed.lastWeeklyDigestAt ?? null,
      announcedMerchantIds: Array.isArray(parsed.announcedMerchantIds)
        ? parsed.announcedMerchantIds.slice(-MAX_RECENT_MERCHANTS)
        : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    throw err;
  }
}

export async function save(file: string, state: BotState): Promise<void> {
  // Cap announced merchants so the file does not grow without bound.
  const trimmed: BotState = {
    ...state,
    announcedMerchantIds: state.announcedMerchantIds.slice(
      -MAX_RECENT_MERCHANTS,
    ),
  };
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

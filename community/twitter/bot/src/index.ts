import { setTimeout as sleep } from 'node:timers/promises';
import { env } from './env.js';
import { logger } from './logger.js';
import { fetchStats, StatsFetchError } from './stats.js';
import {
  draftDevotionDigest,
  draftNewMerchant,
  draftTpvMilestone,
  TPV_THRESHOLDS_USDC,
  type DraftedTweet,
} from './milestones.js';
import { load, save, type BotState } from './state.js';
import { postTweet, TwitterApiError } from './twitter.js';

/** Pick the largest threshold ≤ current TPV — used to seed lastTpvThresholdUsdc
 *  on first run so we do not flood the timeline with every retroactive
 *  threshold the protocol has ever crossed. */
function highestPassed(currentUsdc: number): number {
  let pick = 0;
  for (const t of TPV_THRESHOLDS_USDC) {
    if (t <= currentUsdc) pick = t;
  }
  return pick;
}

async function maybePost(draft: DraftedTweet): Promise<string | null> {
  if (env.dryRun) {
    logger.info({ kind: draft.kind, text: draft.text }, 'DRY_RUN — would tweet');
    return 'dry-run';
  }
  try {
    const posted = await postTweet(draft.text, env.twitter);
    logger.info({ id: posted.id, kind: draft.kind }, 'tweet posted');
    return posted.id;
  } catch (err) {
    if (err instanceof TwitterApiError) {
      logger.error({ err: err.message, status: err.status }, 'tweet failed');
    } else {
      logger.error({ err }, 'tweet failed');
    }
    return null;
  }
}

async function tick(state: BotState, now: Date = new Date()): Promise<BotState> {
  let stats;
  try {
    stats = await fetchStats(env.apiBase);
  } catch (err) {
    if (err instanceof StatsFetchError) {
      logger.warn({ err: err.message, status: err.status }, 'stats fetch failed');
    } else {
      logger.error({ err }, 'stats fetch crashed');
    }
    return state;
  }

  // First-ever run: do not retroactively announce every threshold the
  // protocol has already crossed. Seed the watermark and skip.
  if (state.lastTpvThresholdUsdc === 0 && state.lastMerchantCount === 0) {
    const seeded: BotState = {
      ...state,
      lastTpvThresholdUsdc: highestPassed(stats.tpvUsdc),
      lastMerchantCount: stats.merchantCount,
      announcedMerchantIds: stats.recentMerchants.map((m) => m.id),
    };
    logger.info(
      {
        seededTpv: seeded.lastTpvThresholdUsdc,
        seededMerchants: seeded.lastMerchantCount,
      },
      'first run — seeding state, no retroactive tweets',
    );
    return seeded;
  }

  let next: BotState = { ...state };

  const tpv = draftTpvMilestone(stats, next);
  if (tpv) {
    const posted = await maybePost(tpv);
    if (posted) {
      // Record the actual current TPV so we never replay the same band.
      next = { ...next, lastTpvThresholdUsdc: stats.tpvUsdc };
    }
  }

  const merchant = draftNewMerchant(stats, next);
  if (merchant) {
    const posted = await maybePost(merchant);
    if (posted) {
      const announced = stats.recentMerchants.map((m) => m.id);
      next = {
        ...next,
        lastMerchantCount: stats.merchantCount,
        announcedMerchantIds: Array.from(
          new Set([...next.announcedMerchantIds, ...announced]),
        ),
      };
    }
  }

  const devotion = draftDevotionDigest(stats, next, now, env.weeklyDigestAt);
  if (devotion) {
    const posted = await maybePost(devotion);
    if (posted) {
      next = { ...next, lastWeeklyDigestAt: now.toISOString() };
    }
  }

  return next;
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  logger.info(
    {
      dryRun: env.dryRun,
      apiBase: env.apiBase,
      pollIntervalSeconds: env.pollIntervalSeconds,
      weeklyDigestAt: env.weeklyDigestAt,
      mode: once ? 'one-shot' : 'loop',
    },
    'twitter bot starting',
  );

  let state = await load(env.stateFile);

  let stopping = false;
  const onSignal = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stopping = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  do {
    const next = await tick(state);
    if (next !== state) {
      await save(env.stateFile, next);
      state = next;
    }
    if (once || stopping) break;
    await sleep(env.pollIntervalSeconds * 1000);
  } while (!stopping);

  logger.info('twitter bot exited');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});

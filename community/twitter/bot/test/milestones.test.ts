import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftDevotionDigest,
  draftNewMerchant,
  draftTpvMilestone,
} from '../src/milestones.js';
import type { PlatformStats } from '../src/stats.js';
import type { BotState } from '../src/state.js';

const baseStats: PlatformStats = {
  tpvUsdc: 0,
  merchantCount: 0,
  activeSubscriptions: 0,
  paymentsCount: 0,
  recentMerchants: [],
};

const baseState: BotState = {
  lastTpvThresholdUsdc: 0,
  lastMerchantCount: 0,
  lastWeeklyDigestAt: null,
  announcedMerchantIds: [],
};

test('TPV milestone fires only above last announced threshold', () => {
  const stats = { ...baseStats, tpvUsdc: 1_250_000 };
  const fresh = draftTpvMilestone(stats, baseState);
  assert.ok(fresh, 'should fire on first $1M crossing');
  assert.match(fresh!.text, /\$1M/);

  const seen = draftTpvMilestone(stats, {
    ...baseState,
    lastTpvThresholdUsdc: 1_250_000,
  });
  assert.equal(seen, null, 'should not re-fire same band');
});

test('TPV milestone picks highest tripped band, not the lowest', () => {
  const stats = { ...baseStats, tpvUsdc: 12_000_000 };
  const draft = draftTpvMilestone(stats, baseState);
  assert.ok(draft);
  assert.match(draft!.text, /\$10M/);
});

test('new-merchant draft skips already-announced ids', () => {
  const stats: PlatformStats = {
    ...baseStats,
    merchantCount: 2,
    recentMerchants: [
      { id: 'm_old', name: 'Old Co', createdAt: '2026-01-01' },
      { id: 'm_new', name: 'New Co', createdAt: '2026-05-10' },
    ],
  };

  const first = draftNewMerchant(stats, baseState);
  assert.ok(first);
  assert.match(first!.text, /New Co/);

  const second = draftNewMerchant(stats, {
    ...baseState,
    announcedMerchantIds: ['m_old', 'm_new'],
  });
  assert.equal(second, null);
});

test('devotion digest fires only at scheduled weekday/hour', () => {
  const stats = {
    ...baseStats,
    activeSubscriptions: 42,
    paymentsCount: 1234,
    merchantCount: 7,
  };
  const monday15 = new Date(Date.UTC(2026, 4, 11, 15, 30, 0));
  const tuesday15 = new Date(Date.UTC(2026, 4, 12, 15, 30, 0));

  const onSchedule = draftDevotionDigest(stats, baseState, monday15, {
    weekday: 1,
    hour: 15,
  });
  assert.ok(onSchedule);
  assert.match(onSchedule!.text, /42 active subscriptions/);

  const offSchedule = draftDevotionDigest(stats, baseState, tuesday15, {
    weekday: 1,
    hour: 15,
  });
  assert.equal(offSchedule, null);
});

test('devotion digest respects 6-day floor across restarts', () => {
  const stats = {
    ...baseStats,
    activeSubscriptions: 10,
    paymentsCount: 100,
    merchantCount: 3,
  };
  const monday = new Date(Date.UTC(2026, 4, 11, 15, 0, 0));
  const lastFiredAt = new Date(monday.getTime() - 24 * 60 * 60 * 1000);

  const draft = draftDevotionDigest(
    stats,
    { ...baseState, lastWeeklyDigestAt: lastFiredAt.toISOString() },
    monday,
    { weekday: 1, hour: 15 },
  );
  assert.equal(draft, null, 'within 6 days of last digest — must not re-fire');
});

test('devotion digest is silent when there is nothing to report', () => {
  const monday15 = new Date(Date.UTC(2026, 4, 11, 15, 0, 0));
  const draft = draftDevotionDigest(baseStats, baseState, monday15, {
    weekday: 1,
    hour: 15,
  });
  assert.equal(draft, null);
});

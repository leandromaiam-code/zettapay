import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSyntheticMonitorConfigFromEnv,
  runSyntheticProbe,
  startSyntheticMonitor,
} from "../src/services/synthetic_monitor.js";

interface FakeLog {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLog {
  const fn = (): FakeLog => log;
  const log: FakeLog = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(fn),
  };
  return log;
}

const TARGET = "https://api.zettapay.example/pay";

describe("runSyntheticProbe", () => {
  it("classifies a fast 200 as ok", async () => {
    let t = 1_000;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await runSyntheticProbe({
      targetUrl: TARGET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => {
        t += 50;
        return t;
      },
      latencyThresholdMs: 2000,
    });
    expect(result.outcome).toBe("ok");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.latencyMs).toBe(50);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("flags a slow but successful probe as 'slow'", async () => {
    let t = 1_000;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await runSyntheticProbe({
      targetUrl: TARGET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => {
        t += 2_500;
        return t;
      },
      latencyThresholdMs: 2_000,
    });
    expect(result.outcome).toBe("slow");
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBe(2_500);
  });

  it("flags a 500 response as non_2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const result = await runSyntheticProbe({
      targetUrl: TARGET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("non_2xx");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it("captures network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runSyntheticProbe({
      targetUrl: TARGET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.outcome).toBe("network_error");
    expect(result.status).toBeNull();
    expect(result.latencyMs).toBeNull();
    expect(result.error).toContain("fetch failed");
  });

  it("issues POST with idempotency header when usePost=true", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    await runSyntheticProbe({
      targetUrl: TARGET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      usePost: true,
      postBody: { merchantId: "merch_test", amount: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    const initObj = init as RequestInit & { headers: Record<string, string> };
    expect(initObj.method).toBe("POST");
    expect(initObj.headers["content-type"]).toBe("application/json");
    expect(initObj.headers["idempotency-key"]).toMatch(/^synthetic-/);
    expect(initObj.body).toBe(
      JSON.stringify({ merchantId: "merch_test", amount: 1 }),
    );
  });
});

describe("startSyntheticMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("only alerts after the consecutive-failure threshold and clears on recovery", async () => {
    const log = makeLogger();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return new Response("oops", { status: 500 });
      return new Response("{}", { status: 200 });
    });

    const monitor = startSyntheticMonitor({
      targetUrl: TARGET,
      intervalMs: 60_000,
      latencyThresholdMs: 2_000,
      alertAfterFailures: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: log,
    });

    const r1 = await monitor.tick();
    expect(r1.ok).toBe(false);
    expect(monitor.state().alarmRaised).toBe(false);

    const r2 = await monitor.tick();
    expect(r2.ok).toBe(false);
    expect(monitor.state().alarmRaised).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      "synthetic_monitor.alert_raised",
      expect.objectContaining({ outcome: "non_2xx", consecutiveFailures: 2 }),
    );

    const r3 = await monitor.tick();
    expect(r3.ok).toBe(true);
    expect(monitor.state().alarmRaised).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      "synthetic_monitor.alert_cleared",
      expect.objectContaining({ status: 200 }),
    );

    await monitor.close();
  });

  it("does not alert on a single transient failure", async () => {
    const log = makeLogger();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("oops", { status: 503 });
      return new Response("{}", { status: 200 });
    });

    const monitor = startSyntheticMonitor({
      targetUrl: TARGET,
      latencyThresholdMs: 2_000,
      alertAfterFailures: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: log,
    });

    await monitor.tick();
    await monitor.tick();
    expect(monitor.state().alarmRaised).toBe(false);
    expect(log.error).not.toHaveBeenCalledWith(
      "synthetic_monitor.alert_raised",
      expect.anything(),
    );
    await monitor.close();
  });

  it("invokes onResult listener after each probe", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const onResult = vi.fn();
    const monitor = startSyntheticMonitor({
      targetUrl: TARGET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onResult,
    });
    await monitor.tick();
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0]![0]).toMatchObject({ outcome: "ok" });
    await monitor.close();
  });
});

describe("readSyntheticMonitorConfigFromEnv", () => {
  it("disables when no target URL is set", () => {
    const config = readSyntheticMonitorConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.targetUrl).toBeNull();
  });

  it("enables with sane defaults when only target is set", () => {
    const config = readSyntheticMonitorConfigFromEnv({
      SYNTHETIC_MONITOR_TARGET_URL: TARGET,
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.targetUrl).toBe(TARGET);
    expect(config.intervalMs).toBe(60_000);
    expect(config.latencyThresholdMs).toBe(2_000);
    expect(config.alertAfterFailures).toBe(2);
    expect(config.usePost).toBe(false);
  });

  it("respects explicit disable", () => {
    const config = readSyntheticMonitorConfigFromEnv({
      SYNTHETIC_MONITOR_TARGET_URL: TARGET,
      SYNTHETIC_MONITOR_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
  });

  it("parses POST mode and JSON body", () => {
    const config = readSyntheticMonitorConfigFromEnv({
      SYNTHETIC_MONITOR_TARGET_URL: TARGET,
      SYNTHETIC_MONITOR_METHOD: "POST",
      SYNTHETIC_MONITOR_POST_BODY: '{"merchantId":"m_1","amount":0.01}',
      SYNTHETIC_MONITOR_LATENCY_THRESHOLD_MS: "1500",
    } as NodeJS.ProcessEnv);
    expect(config.usePost).toBe(true);
    expect(config.postBody).toEqual({ merchantId: "m_1", amount: 0.01 });
    expect(config.latencyThresholdMs).toBe(1_500);
  });

  it("ignores invalid JSON bodies", () => {
    const config = readSyntheticMonitorConfigFromEnv({
      SYNTHETIC_MONITOR_TARGET_URL: TARGET,
      SYNTHETIC_MONITOR_POST_BODY: "{not-json",
    } as NodeJS.ProcessEnv);
    expect(config.postBody).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  Counter,
  Histogram,
  Registry,
  httpRequestDurationSeconds,
  httpRequestsTotal,
  paymentVolumeUsdcTotal,
  paymentsTotal,
  recordPaymentOutcome,
  registry,
} from "../src/lib/metrics.js";

afterEach(() => {
  registry.resetForTest();
});

describe("Counter", () => {
  it("renders a zero baseline before any inc()", () => {
    const c = new Counter("test_zero", "no observations yet", []);
    const text = c.render();
    expect(text).toContain("# HELP test_zero no observations yet");
    expect(text).toContain("# TYPE test_zero counter");
    expect(text).toContain("test_zero 0");
  });

  it("accumulates increments per label set", () => {
    const c = new Counter("test_counter", "h", ["status"]);
    c.inc({ status: "ok" }, 2);
    c.inc({ status: "ok" });
    c.inc({ status: "error" }, 5);
    const text = c.render();
    expect(text).toContain('test_counter{status="ok"} 3');
    expect(text).toContain('test_counter{status="error"} 5');
  });

  it("rejects negative increments", () => {
    const c = new Counter("test_neg", "h", []);
    expect(() => c.inc({}, -1)).toThrow(/cannot decrease/);
  });

  it("escapes label values with quotes / backslashes / newlines", () => {
    const c = new Counter("test_escape", "h", ["v"]);
    c.inc({ v: 'a"b\\c\nd' });
    const text = c.render();
    expect(text).toContain('test_escape{v="a\\"b\\\\c\\nd"} 1');
  });
});

describe("Histogram", () => {
  it("renders empty baseline buckets before any observation", () => {
    const h = new Histogram("test_hist", "h", [], [0.1, 1]);
    const text = h.render();
    expect(text).toContain("# TYPE test_hist histogram");
    expect(text).toContain('test_hist_bucket{le="0.1"} 0');
    expect(text).toContain('test_hist_bucket{le="1"} 0');
    expect(text).toContain('test_hist_bucket{le="+Inf"} 0');
    expect(text).toContain("test_hist_sum 0");
    expect(text).toContain("test_hist_count 0");
  });

  it("counts observations into the correct buckets", () => {
    const h = new Histogram("lat", "h", ["route"], [0.1, 0.5, 1]);
    h.observe({ route: "/pay" }, 0.05); // <= 0.1, 0.5, 1
    h.observe({ route: "/pay" }, 0.4); // <= 0.5, 1
    h.observe({ route: "/pay" }, 2); // <= +Inf only
    const text = h.render();
    expect(text).toContain('lat_bucket{le="0.1",route="/pay"} 1');
    expect(text).toContain('lat_bucket{le="0.5",route="/pay"} 2');
    expect(text).toContain('lat_bucket{le="1",route="/pay"} 2');
    expect(text).toContain('lat_bucket{le="+Inf",route="/pay"} 3');
    expect(text).toContain('lat_count{route="/pay"} 3');
    expect(text).toMatch(/lat_sum\{route="\/pay"\} 2\.45/);
  });

  it("ignores negative or non-finite observations", () => {
    const h = new Histogram("lat2", "h", [], [1]);
    h.observe({}, -1);
    h.observe({}, Number.NaN);
    h.observe({}, Number.POSITIVE_INFINITY);
    const text = h.render();
    expect(text).toContain('lat2_bucket{le="1"} 0');
    expect(text).toContain("lat2_sum 0");
  });

  it("rejects duplicate bucket boundaries", () => {
    expect(() => new Histogram("dup", "h", [], [0.1, 0.1])).toThrow(/duplicate/);
  });
});

describe("Registry", () => {
  it("rejects duplicate registrations", () => {
    const r = new Registry();
    r.register(new Counter("dup_metric", "h"));
    expect(() => r.register(new Counter("dup_metric", "h"))).toThrow(/already registered/);
  });

  it("renders all registered metrics joined with a trailing newline", () => {
    const r = new Registry();
    r.register(new Counter("first", "f"));
    r.register(new Counter("second", "s"));
    const text = r.render();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("# HELP first");
    expect(text).toContain("# HELP second");
  });
});

describe("recordPaymentOutcome", () => {
  it("increments both the count and volume counters on completion", () => {
    recordPaymentOutcome("completed", "USDC", 12.5);
    const text = registry.render();
    expect(text).toContain('zettapay_payments_total{currency="USDC",status="completed"} 1');
    expect(text).toContain(
      'zettapay_payment_volume_usdc_total{currency="USDC",status="completed"} 12.5',
    );
  });

  it("counts failures but does not bump volume when amount is zero", () => {
    recordPaymentOutcome("failed", "USDC", 0);
    expect(paymentsTotal.render()).toContain(
      'zettapay_payments_total{currency="USDC",status="failed"} 1',
    );
    // Volume counter should still render its zero baseline.
    expect(paymentVolumeUsdcTotal.render()).toContain("zettapay_payment_volume_usdc_total 0");
  });
});

describe("global HTTP metric registrations", () => {
  it("exposes both request counter and latency histogram on the registry", () => {
    httpRequestsTotal.inc({
      method: "GET",
      route: "/ping",
      status: "200",
      status_class: "2xx",
    });
    httpRequestDurationSeconds.observe({ method: "GET", route: "/ping" }, 0.012);
    const text = registry.render();
    expect(text).toContain("# TYPE zettapay_http_requests_total counter");
    expect(text).toContain("# TYPE zettapay_http_request_duration_seconds histogram");
    expect(text).toContain('zettapay_http_requests_total{');
    expect(text).toContain('zettapay_http_request_duration_seconds_bucket{');
  });
});

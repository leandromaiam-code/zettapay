# Self-hosted observability stack

Prometheus + Grafana for operators running ZettaPay outside Vercel. Scrapes
the API's `/metrics` endpoint and provisions a single overview dashboard
covering the SLA panels: latency p50/p95/p99, RPS, 5xx error rate, and USDC
payment volume.

## Layout

```
infra/observability/
├── docker-compose.yml             # Prometheus + Grafana services
├── prometheus/
│   └── prometheus.yml             # Scrape config (target: api:3001/metrics)
└── grafana/
    ├── provisioning/
    │   ├── datasources/prometheus.yml   # Pinned datasource UID
    │   └── dashboards/dashboards.yml    # Filesystem provider
    └── dashboards/
        └── zettapay-overview.json       # SLA panels
```

## Bring it up

The Prometheus container needs to resolve `api:3001` (the ZettaPay API). The
quickest path is to run the API stack first so its Docker network exists,
then attach this stack to it.

```bash
# 1. Start the API + DB
docker compose -f docker-compose.yml up -d
# Confirm the network name (zettapay_default by default):
docker network ls | grep zettapay

# 2. Start the observability stack on the same network
ZETTAPAY_NETWORK=zettapay_default \
  docker compose -f infra/observability/docker-compose.yml up -d

# 3. Open Grafana on http://localhost:3000
#    Default creds: admin / admin (override via GRAFANA_ADMIN_PASSWORD)
```

The provisioned dashboard "ZettaPay · API Overview" appears under the
**ZettaPay** folder.

## Metrics exposed by the API

| Metric                                          | Type      | Drives                          |
| ----------------------------------------------- | --------- | ------------------------------- |
| `zettapay_http_requests_total`                  | counter   | RPS, error rate (4xx / 5xx)     |
| `zettapay_http_request_duration_seconds`        | histogram | Latency p50 / p95 / p99         |
| `zettapay_payments_total`                       | counter   | Payment success rate            |
| `zettapay_payment_volume_usdc_total`            | counter   | USDC volume per second / status |
| `zettapay_build_info`, beta gauges, process_*   | gauges    | Process + release context       |

Scrape interval is 15s. Adjust `prometheus/prometheus.yml` if you need finer
resolution; remember Prometheus storage scales with `samples × series`.

## Alerting

Out of scope for this dashboard pass — wire your existing Alertmanager
provider into the Prometheus instance via additional `scrape_configs` or a
sibling `alerting:` block. Recommended starter rules:

- `histogram_quantile(0.99, sum by (le) (rate(zettapay_http_request_duration_seconds_bucket[5m]))) > 1`
  for 10m → page on-call (latency SLO).
- `sum(rate(zettapay_http_requests_total{status_class="5xx"}[5m])) / sum(rate(zettapay_http_requests_total[5m])) > 0.01`
  for 5m → page on-call (error budget burn).

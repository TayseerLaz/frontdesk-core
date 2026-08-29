# Observability / SLA (Tier 4)

You already emit the hard part (metrics + Sentry). This tier adds **alerting**
(know before the customer does) and the few exporters that surface infra health.

## Scrape targets (`prometheus.yml`)
```yaml
global: { scrape_interval: 15s }
rule_files: [ "alerts.yml" ]
alerting:
  alertmanagers: [ { static_configs: [ { targets: ["localhost:9093"] } ] } ]
scrape_configs:
  - job_name: api
    metrics_path: /metrics
    static_configs: [ { targets: ["<app1>:4000","<app2>:4000"] } ]
  - job_name: worker
    static_configs: [ { targets: ["<app1>:9100","<app2>:9100"] } ]
  - job_name: api-ready                 # blackbox probe of /health/ready
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs: [ { targets: ["https://api.hader.ai/health/ready"] } ]
    relabel_configs:                     # via blackbox_exporter
      - { source_labels: [__address__], target_label: __param_target }
      - { source_labels: [__param_target], target_label: instance }
      - { target_label: __address__, replacement: localhost:9115 }
  - job_name: node                       # node_exporter on every VM
    static_configs: [ { targets: ["<app1>:9100x","<db1>:9100x","<db2>:9100x"] } ]
  - job_name: postgres                   # postgres_exporter on each DB node
    static_configs: [ { targets: ["<db1>:9187","<db2>:9187"] } ]
  - job_name: redis                      # redis_exporter
    static_configs: [ { targets: ["<app1>:9121","<app2>:9121"] } ]
  - job_name: caddy
    metrics_path: /metrics
    static_configs: [ { targets: ["<lb>:2019"] } ]
```
> `node_exporter` and the worker both default to :9100 — give node_exporter a
> different port on the app nodes (shown as `9100x`).

## Exporters (one-liners)
- `node_exporter` (apt) — disk/cpu/mem/load.
- `postgres_exporter` — **the important one**: replication lag, `pg_stat_archiver`
  (WAL-archive failures = PITR broken), connections, slow queries.
- `redis_exporter` — up/memory/evictions.
- `blackbox_exporter` — external probe of `/health/ready` (catches "up but
  dependencies down").

## Alertmanager (`alertmanager.yml`) — route to where you'll actually see it
```yaml
route:
  receiver: ops
  group_by: [alertname]
  group_wait: 30s
  repeat_interval: 4h
  routes:
    - matchers: [ 'severity="page"' ]
      receiver: ops-page          # phone/PagerDuty/Opsgenie for full-outage
receivers:
  - name: ops
    slack_configs:                # or email_configs via your SES SMTP
      - { api_url: "<SLACK_WEBHOOK>", channel: "#alerts", send_resolved: true }
  - name: ops-page
    webhook_configs: [ { url: "<PAGERDUTY_OR_OPSGENIE_WEBHOOK>" } ]
```

## The SLA you can credibly offer once this is live
Redundant DB + app, PITR (RPO ≈ seconds), auto-failover (RTO < 1 min),
auto-rollback deploys, and **alerting on every dependency** → a defensible
99.9 % uptime SLA for enterprise contracts.

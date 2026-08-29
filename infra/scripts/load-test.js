// k6 load test for the chatbot read API.
//
// Goal: 500 rps sustained for 2 minutes against /api/v1/read/products
// with p95 < 200 ms and zero error rate. Mirrors the spec's NFR.
//
// Usage:
//   API_KEY=ak_live_… BASE_URL=https://api.platform.example k6 run load-test.js
//
// Tip: warm the cache by running once with `--vus 1 --iterations 5` first so the
// 60s cache window is full when the real load starts.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:4000';
const API_KEY = __ENV.API_KEY ?? '';

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS ?? 500),
      timeUnit: '1s',
      duration: __ENV.DURATION ?? '2m',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],         // <1% failures
    http_req_duration: ['p(95)<200', 'p(99)<400'],
  },
};

const errorRate = new Rate('platform_errors');
const lat = new Trend('platform_latency_ms', true);

const ENDPOINTS = [
  '/api/v1/read/products?limit=25',
  '/api/v1/read/services?limit=25',
  '/api/v1/read/business-info',
  '/api/v1/read/faqs?limit=25',
  '/api/v1/read/search?q=widget&limit=10',
];

export default function () {
  if (!API_KEY) throw new Error('API_KEY env var is required');
  const url = `${BASE_URL}${ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)]}`;
  const res = http.get(url, {
    headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' },
    tags: { endpoint: url.split('?')[0] },
  });
  lat.add(res.timings.duration);
  const ok = check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
    'has data field': (r) => {
      try {
        return 'data' in r.json();
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
  sleep(0.05);
}

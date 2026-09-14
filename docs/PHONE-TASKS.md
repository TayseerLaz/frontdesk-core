# Phone tasks — CALL-E phone follow-through

The chat bot is the front door. A phone task is what happens when a record it opened needs a human
voice to close it: a cash-on-delivery order nobody confirmed, an appointment tomorrow the customer
has gone quiet on, or a one-off question an operator wants asked out loud.

The call is placed by [CALL-E](https://www.heycall-e.com/). What makes it a feature rather than a
dialler is that the answer comes back as **schema-validated JSON**, and that JSON is allowed to
change a business record only under rules written down here.

For a hands-on walkthrough, see [../TESTING.md](../TESTING.md).

---

## 1 · The three kinds

| Kind | Trigger | Brief is compiled from | May change |
|---|---|---|---|
| `cod_order_confirm` | **Confirm by phone** on an order, or the auto-confirm tick | the cart rows, the delivery address field, the shipping policy, the tenant's legal name and language | `carts.status` |
| `booking_confirm` | **Confirm by phone** on a booking | the booking row, its appointment time in the tenant's timezone, the service field | `bookings.status` |
| `custom` | an operator's typed goal, from an inbox thread or the Phone tasks page | the operator's goal plus the business identity | nothing — note only |

The brief is compiled from **database rows, never from chat text**. A model summarising a
conversation will confidently read back an item the customer never ordered; reading the cart rows
cannot.

---

## 2 · Anatomy

```
apps/api/src/lib/
  calle.ts               the ONLY importer of @call-e/calle
  phone-tasks.ts         task builders + the governed write-back
  phone-task-decision.ts the write-back rule, pure and unit-tested
  phone-task-tick.ts     30s poller + the COD auto-confirm scanner
apps/api/src/modules/phone-tasks/
  phone-tasks.routes.ts  portal API (JWT, feature-gated)
  calle-webhook.routes.ts terminal-event receiver (public, token in URL)
apps/web/src/app/(dashboard)/phone-tasks/
  page.tsx               list, result drawer, automation settings, try-it card
packages/db/prisma/       phone_tasks table + RLS
packages/shared/src/schemas/phone-task.ts   the wire contract
```

### `calle.ts` — three rails, enforced in code

1. **Dry run is the default.** `CALLE_DRY_RUN` defaults to true. Nothing is dialled; the task
   completes after fifteen seconds with a result synthesised from its own JSON Schema, labelled DRY
   RUN wherever it appears. The whole write-back path still runs, so the feature is reviewable with
   no credentials.
2. **Live override.** While `CALLE_LIVE_OVERRIDE_PHONE` is set, every live call is redirected to
   that one number and the substitution is recorded in the call metadata. A demo cannot dial a real
   customer by accident.
3. **Region gate.** CALL-E dials 23 countries. Anything else is refused before a task row exists,
   rather than failing mid-call.

### The request

```ts
client.calls.create(
  { task, recipients: [{ phones, region, locale }], resultSchema, recipientResultSchema, metadata },
  { idempotencyKey },
)
```

The idempotency key is `phone-task:<org>:<kind>:<target>:<attempt>:v1` and is **persisted before the
first request**, so retrying that attempt cannot become a second call. A deliberate new attempt gets
a new key; a call the provider has already accepted cannot be recalled.

---

## 3 · Results: two paths, one write

A terminal result can arrive two ways, and both are wired:

- **Webhook.** `POST /api/v1/calle/webhook/:orgId?token=…`. CALL-E deliveries are unsigned by
  design, so the receiver checks a per-deployment token in the URL, requires the `CALL-E-Event-Id`
  header to match the body id, deduplicates that id in Redis for seven days, and then **re-reads the
  call from the API** rather than trusting the delivered body.
- **Poll.** A 30-second tick inside the API process. This is the dependable path on a laptop, where
  no public HTTPS URL exists.

Both call `applyResult`, which opens with a compare-and-set on `applied_at`. Whichever arrives first
wins; the other sees zero rows updated and returns. Neither can apply twice.

---

## 4 · The rule that decides

`phone-task-decision.ts` is deliberately pure — no Prisma, no env, no network — so the
safety-critical logic is testable without a database and is not buried in the engine.

A record may change only when **all** of these hold:

- CALL-E reports `status: completed`
- `task_completed` is true
- `completion_confidence.score` ≥ **0.7**
- a structured result exists
- the disposition is unambiguous **and not contradicted** by the rest of the extraction

Concretely, for an order:

| Extraction | Outcome |
|---|---|
| `disposition: confirmed` **and** `confirmed: yes` | order → `confirmed` |
| `disposition: cancelled` and not `confirmed: yes` | order → `cancelled` |
| everything else, including `changed`, voicemail, no answer, wrong number, low confidence, schema drift | `needs_review`, record untouched |

> **A bug worth recording.** The first version cancelled an order whenever the extraction carried
> `confirmed: "no"`, whatever the disposition. A customer saying *"no, not like that, I want to add
> something"* returns `disposition: changed` with `confirmed: "no"` — so a request for a change
> would have cancelled the order. A reviewer on the CALL-E community repository caught it while
> reviewing the submission PR. Cancellation now requires an explicit `cancelled` disposition, and
> sixteen unit tests cover the rule.

Whatever the outcome, every finished call leaves an internal note on the customer's own inbox
thread, raises a notification, and fires the tenant's outbound webhook.

---

## 5 · Bounds on spend and nuisance

- Contacts with `opted_out_at` or `blocked_at` are refused before a task row exists.
- A per-tenant daily cap, floored by the `PHONE_TASK_DAILY_CAP` env ceiling.
- Auto-confirm is **off by default**, per tenant, with a delay after the order lands so the customer
  can finish the chat first, and a per-tick ceiling so a backlog cannot burst.
- Disabling auto-confirm stops future tasks. It does not recall a call the provider has accepted.

---

## 6 · Tenancy

`phone_tasks` carries `organization_id` and is protected by the same Postgres row-level security as
every other tenant table, applied inline in its migration and again in `rls.sql`.
`apps/api/test/tenant-isolation.test.ts` — the blocking deploy gate — has a case proving org A can
neither read a phone task of org B through the API nor see the row with the connection rebound at
the database level.

---

## 7 · Environment

| Variable | Default | Meaning |
|---|---|---|
| `CALLE_API_KEY` | — | Required only for live calls |
| `CALLE_BASE_URL` | `https://api.heycall-e.com` | Point at a mock to exercise the live path offline |
| `CALLE_DRY_RUN` | `true` | The committed default |
| `CALLE_LIVE_OVERRIDE_PHONE` | — | Redirects every live call to one verified number |
| `CALLE_WEBHOOK_TOKEN` | — | Enables the webhook receiver; without it the poller is the only path |
| `PHONE_TASK_DAILY_CAP` | `50` | Per-tenant per-day ceiling |

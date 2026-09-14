# Testing this project

**FrontDesk Phone Follow-Through** — a multi-tenant AI front desk for WhatsApp, Messenger and
Instagram, which now **picks up the phone through CALL-E** to confirm cash-on-delivery orders and
appointments, and writes the structured result back to the record and the conversation.

This page is written for someone evaluating the project. It gets you from a fresh clone to a real
phone call in about fifteen minutes.

There are two ways to evaluate it:

| | What you need | What you get |
|---|---|---|
| **A · Dry run** | Nothing. No CALL-E account, no API key, no phone. | The entire flow runs end to end with a synthetic result: the task row, the status machine, the order flipping, the inbox note, the notification, the webhook. Nothing is dialled. |
| **B · Real call** | A free CALL-E account and a phone in a supported country. | The AI rings **your** phone, holds the conversation, and the extracted JSON changes the order in front of you. |

Start with A. It takes five minutes and needs no credentials. Then do B if you want to hear it.

---

## 1 · Prerequisites

- **Node.js 20.11+** and **pnpm 9+** (`npm i -g pnpm`)
- **PostgreSQL 16** and **Redis 7**. The repo ships a compose file, so Docker is the easy path.
  If you already run Postgres and Redis locally, point the connection strings at them instead.

---

## 2 · Set up

```bash
git clone https://github.com/TayseerLaz/frontdesk-core.git
cd frontdesk-core

cp .env.example .env
```

Open `.env` and set the four variables that have no safe default. Everything else in the file
already works out of the box, and every integration the project does not have a key for simply
reports itself as unconfigured rather than crashing.

```bash
# Generate two secrets and paste them in:
openssl rand -base64 48   # → JWT_ACCESS_SECRET
openssl rand -base64 48   # → JWT_REFRESH_SECRET
```

```ini
JWT_ACCESS_SECRET="<first value>"
JWT_REFRESH_SECRET="<second value>"
INITIAL_ADMIN_EMAIL="you@example.com"
INITIAL_ADMIN_PASSWORD="pick-something-12-chars-or-more"
```

`DATABASE_URL` and `REDIS_URL` already match the compose file, so leave them alone unless you are
using your own Postgres or Redis.

Then bring it up:

```bash
docker compose up -d          # postgres, pgbouncer, redis, mailhog
pnpm install
pnpm bootstrap                # applies the migrations, creates your admin user
pnpm seed:demo                # loads the Aurora Skin Clinic demo tenant
pnpm dev:demo                 # portal on :3000, API on :4000
```

> `pnpm dev:demo` starts just the API and the portal, which is all this walkthrough needs. The
> background worker and the optional WhatsApp capture service are not required — the phone-task
> poller runs inside the API process. Plain `pnpm dev` starts everything, including a service that
> refuses to boot without its own configuration.

Open **<http://localhost:3000/app>** and sign in:

```
calle@hackathon.com
CallE-Hackathon-2026!
```

> That is a normal clinic staff account. `pnpm bootstrap` also created a super-admin from your
> `INITIAL_ADMIN_*` values, but the super-admin sees the cross-tenant HQ view, which deliberately
> hides tenant-only pages including Phone tasks. Use the clinic login for everything below.

### What you are looking at

The tenant is **Aurora Skin Clinic**, a London skin clinic that both books treatments and sells
retail skincare, because the phone feature covers both. Seeded with eight products, six services,
FAQs and policies, ten contacts, seven WhatsApp conversations, five orders and six bookings.

Two records are deliberately left unconfirmed:

- an order from **Amelia Hart** for £108.50, sitting at `new` on **Orders**
- a **Skin Consultation** for **Priya Raman** tomorrow morning, on **Bookings**

Customer numbers use Ofcom's reserved fictional range (`+44 7700 900xxx`), so nothing in the seed
can reach a real person.

---

## 3 · Walkthrough A — dry run, no credentials

`CALLE_DRY_RUN=true` is the committed default, so this works immediately.

1. Go to **Orders**. Find Amelia Hart's order at `new` and click **Confirm by phone**.
2. Go to **Phone tasks**. A task appears as `Queued`, then `Calling…`.
3. About fifteen seconds later it completes. Click the row.

You will see a summary, the structured result the schema asked for, a transcript, the exact brief
that was given to the agent, and the JSON Schema that was sent to CALL-E. The banner at the top
says DRY RUN, and so does the summary, so a synthetic result can never be mistaken for a real one.

4. Go back to **Orders**. Amelia's order now reads `confirmed`.
5. Click **View chat** on that row. The call summary has been posted as an internal note in the
   customer's own WhatsApp thread.

Everything that would happen on a real call happened here, except the dialling.

Repeat on **Bookings** with Priya Raman's appointment if you want to see the second task type.

To reset the demo to its starting state at any point:

```bash
pnpm seed:demo
```

---

## 4 · Walkthrough B — a real call to your own phone

### 4.1 Get a CALL-E key

1. Install and sign in:
   ```bash
   npx -y skills add https://github.com/CALLE-AI/call-e-integrations --skill calle -g
   npx @call-e/cli auth login
   ```
2. Copy your key from <https://dashboard.heycall-e.com/account/api-keys>. New accounts include
   twenty free calls.

### 4.2 Check your country is supported

CALL-E can dial 23 countries. Your phone must be in one of them:

> Australia, Bangladesh, Brazil, Canada, China, Germany, Spain, Finland, United Kingdom, Indonesia,
> India, Japan, Mexico, Malaysia, Netherlands, Philippines, Pakistan, Poland, Singapore, Thailand,
> Turkey, United States, Vietnam.

Anything else is refused before a task row is written, with a `PHONE_TASK_REGION_UNSUPPORTED` error.
That gate is deliberate: it is better to say so up front than to fail halfway through a call.

### 4.3 Switch to live mode

In `.env`:

```ini
CALLE_API_KEY=<your key>
CALLE_DRY_RUN=false
CALLE_LIVE_OVERRIDE_PHONE=        # leave EMPTY so it dials the number you type
```

Restart the API so it reads the new values:

```bash
kill $(lsof -ti :4000)
pnpm dev:demo
```

On **Phone tasks** the banner should turn green and read *Live via CALL-E*.

> `CALLE_LIVE_OVERRIDE_PHONE` is a safety valve: while it is set, **every** live call is redirected
> to that one number regardless of who the record belongs to, and the substitution is recorded in
> the call metadata. It is enforced in `apps/api/src/lib/calle.ts`, not in documentation. Leave it
> empty for this walkthrough; set it if you ever point this at real customer data.

### 4.4 Call yourself

On **Phone tasks**, use the **Try it on your own phone** card in the right-hand column.

1. Type your number in international format, for example `+14155550100`.
2. Edit the goal if you like. The default asks whether you can hear clearly and proposes a
   consultation time.
3. Click **Call me now**.

Your phone rings within about a minute. Talk to it normally. When you hang up, the task on the left
moves to `Completed` and carries the summary, the confidence score, the extracted JSON and the full
transcript.

That card exists precisely so you can hear the agent without touching a customer record.

### 4.5 Then try the real thing

The interesting path is the one the product actually uses. Set
`CALLE_LIVE_OVERRIDE_PHONE` to your own number, restart, and click **Confirm by phone** on Amelia
Hart's order. The override sends the call to you instead of to the fictional customer, and the AI
reads back the real order lines and total from the database.

**Confirm without asking for changes** and the order flips to `confirmed`.

**Ask to add an item, or be vague** and it will not. CALL-E returns `disposition: changed` or a low
confidence score, the task becomes `needs_review`, the order stays `new`, and a warning notification
is raised for a human. That is the rule this project is really about, and it is worth testing on
purpose.

---

## 5 · What to look at in the code

| Question | Where |
|---|---|
| Where is CALL-E actually called? | `apps/api/src/lib/calle.ts` — the only file importing `@call-e/calle`. `client.calls.create` with `result_schema`, `recipient_result_schema`, `metadata` and an `Idempotency-Key`; `client.calls.get` to poll. |
| How is the spoken brief built? | `apps/api/src/lib/phone-tasks.ts` → `specForCart`, `specForBooking`, `specForCustom`. Compiled from the order rows, the stored address, the delivery policy and the tenant's own name. Never from chat text. |
| What decides whether an order moves? | `phone-tasks.ts` → `decide()`. Requires `task_completed`, confidence ≥ 0.7 and an unambiguous disposition. Everything else is `needs_review`. |
| How do results get back? | `apps/api/src/lib/phone-task-tick.ts` polls every 30s; `apps/api/src/modules/phone-tasks/calle-webhook.routes.ts` receives terminal events, deduplicates on `CALL-E-Event-Id`, and re-reads the call from the API rather than trusting the body. Both converge on a compare-and-set in `applyResult`. |
| Is it safe for multiple businesses? | `phone_tasks` is tenant-scoped under Postgres row-level security. `apps/api/test/tenant-isolation.test.ts` has a blocking cross-tenant case for it. |
| Reusable skill | [`skills/cod-order-confirmation-call/`](https://github.com/CALLE-AI/awesome-phone-call-agents/tree/main/skills/cod-order-confirmation-call) — merged into the CALL-E community repository as part of this project. |
| Subsystem write-up | [`docs/PHONE-TASKS.md`](docs/PHONE-TASKS.md) |

---

## 6 · Troubleshooting

| Symptom | Fix |
|---|---|
| `PHONE_TASK_REGION_UNSUPPORTED` | Your number's country is not on CALL-E's list. Use a number from the 23 supported countries. |
| Phone never rings in live mode | Check the banner says *Live via CALL-E*. If it says DRY RUN, the API did not pick up the new `.env` — restart it. Check that `CALLE_LIVE_OVERRIDE_PHONE` is not pointing somewhere else. |
| `Environment variable not found: DIRECT_DATABASE_URL` | Prisma scripts need the env exported: `set -a; . ./.env; set +a` before running them. |
| Port 4000 already in use | `kill $(lsof -ti :4000)` |
| `ENFILE`, or "too many open files in system" | The API dev watcher holds roughly 5,000 file descriptors, so a few stale ones exhaust the system table. Kill them with `pkill -f "tsx/dist/cli.mjs watch"`, then start a single stack again. On macOS, `sysctl -n kern.num_files kern.maxfiles` shows the headroom; raise it with `sudo sysctl -w kern.maxfiles=131072` if you need several stacks at once. |
| `pnpm dev` fails with "Refusing to start: PLATFORM_API_URL must be set" | That is `wa-ingest`, an optional WhatsApp capture service this walkthrough does not use. Run `pnpm dev:demo`, which starts only the API and the portal. |
| Redis authentication error | If you use your own Redis with a password, put it in the URL: `redis://:PASSWORD@localhost:6379`. |
| The nav has no Phone tasks entry | You are signed in as the super-admin, which sees the HQ view. Use `calle@hackathon.com`. |
| Everything is empty | Run `pnpm seed:demo`. |

---

## 7 · What this project will and will not dial

- It never calls a contact who has opted out or been blocked. That is checked before a task row
  exists.
- It refuses countries CALL-E does not support, up front.
- Each task stores an attempt-scoped idempotency key **before** the first request, so retrying that
  attempt cannot become a second call. A new attempt gets a new key, and a call the provider has
  already accepted cannot be recalled by closing the page.
- A per-tenant daily cap and a delay after the order lands bound both spend and nuisance.
- Auto-confirm is off by default and is a per-tenant switch.
- Low confidence never performs a destructive write.

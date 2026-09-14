# Devpost writeup — edited

> Edits made: placeholders filled; the "twenty calls" paragraph corrected (one live call was spent,
> not several, because tuning happened against a local mock); the region bullet corrected to describe
> what the code actually does; the real call's outcome added, because it is the strongest evidence in
> the whole submission; bookings and the inbox action added to "What it does".

---

## Inspiration

I run a WhatsApp AI front desk for small businesses. A restaurant, clinic or gym connects its number, loads its menu or services, and the bot answers customers all day, takes orders and books appointments. It works, until the moment a record needs a human voice.

Two things kept coming up. Most orders from chat are cash on delivery, and a good share of them are never confirmed. The shop sends the driver anyway and eats the failed delivery, or pays someone to phone every order by hand. And once a customer stops replying, WhatsApp itself gets in the way: after 24 hours the business can only send a pre-approved template, so a simple "are you still coming at 4:30?" becomes a compliance exercise.

A phone call has none of those limits. When CALL-E showed up with structured results and an idempotent API, the idea was obvious: keep chat as the front door, and let the phone close the loop.

## What it does

FrontDesk is the existing front desk with a new phone layer, called phone tasks.

- An order or booking lands from WhatsApp as usual.
- An operator clicks **Confirm by phone** on the order or the booking, or a tenant switches on auto-confirm and the system schedules the call itself a few minutes after the order arrives. From any conversation in the inbox, an operator can also type a one-off goal and send the AI to ask it.
- CALL-E dials the customer, reads back the actual items and total from the cart rows (never the chatbot's own text), checks the address or the appointment time, and asks whether it still stands.
- The structured result comes back: confirmed, cancelled, changed, voicemail, no answer, wrong number, or needs a human.
- The order or booking flips to `confirmed` or `cancelled`, a transcript summary lands as a note on the same inbox thread, a notification fires, and the tenant's outbound webhook carries the result to whatever CRM they use.

Low confidence never triggers a destructive write. It routes to `needs_review` and a person decides. The same engine handles booking confirmations the day before an appointment and free-form custom calls.

That rule is not theoretical. On the live test call, the customer confirmed the order and then asked to add an item. CALL-E returned `disposition: changed` with `requested_changes: "Add 1 sub print"` at 88% confidence over a 29-turn transcript, so the system refused to auto-confirm, held the order at `new`, and raised a warning for a human. The first real call the feature ever made landed on the interesting branch rather than the happy path, which is exactly the branch that matters.

## How I built it

The platform is a TypeScript monorepo: Fastify API, BullMQ worker, Next.js portal, PostgreSQL with row-level security, Redis. CALL-E fits in as one new subsystem:

- `lib/calle.ts` is the only file that imports `@call-e/calle`. It creates calls with `client.calls.create`, passes a `result_schema` so the answer comes back as JSON, and sends an idempotency key that is stored before the first request. A dry-run mode returns a deterministic stub so the whole flow can be tested without spending a call.
- A `phone_tasks` table holds every call: target record, task text, schema, CALL-E call id, status, structured result, confidence and transcript. It is tenant-scoped and covered by the same RLS policy as everything else, and the cross-tenant isolation test that blocks deploys was extended to cover it.
- A 30-second tick polls open tasks against `GET /v1/calls/{id}` and applies results. A webhook receiver does the same thing faster when the API is reachable from the internet. Both paths converge on one compare-and-set, so whichever arrives first wins and neither can apply twice.
- The portal got a Phone tasks page with a result drawer, plus a Confirm by phone action on each order and each booking.

Safety came from patterns already in the community repo: dry-run by default, an override phone that forces every live call to a number I own, respect for opted-out and blocked contacts, and a per-tenant daily cap.

The submission PR was merged, and the maintainer's review earned its keep: they spotted that the cash-on-delivery rule cancelled an order whenever the extraction carried `confirmed: "no"`, regardless of disposition. A customer saying "no, not like that, I want to add something" comes back as `changed` with `confirmed: "no"` — so the very case my live test hit would have cancelled the order rather than escalating it, if the disposition check had not caught it first. Cancellation now requires an explicit `cancelled` disposition, the rule moved into its own dependency-free module, and sixteen unit tests cover it. That is the whole thesis of the project in one bug: the hard part is not dialling, it is deciding which answers may change a record.

## Challenges

- **Region support.** Lebanon, where I live and where most of my tenants are, is not one of CALL-E's supported regions. The region gate therefore refuses a local customer before a task row is even written, which is the honest behaviour but also means my own market is not callable yet. I tested on a United States number instead.
- **Twenty calls.** New accounts get twenty free calls and the top-up form takes days, so I could not tune a phone agent by dialing repeatedly. I wrote a small mock of the CALL-E API shaped exactly like the published OpenAPI schema, pointed the client at it, and exercised the entire non-dry-run path against it: request payload, idempotency header, the override redirect, the status machine, confidence parsing, transcript mapping, the order write-back, and the low-confidence branch. Only then did I spend a real call. One credit, first try, worked.
- **Webhooks on a laptop.** CALL-E's webhook needs a public HTTPS URL. Polling turned out to be the dependable path for local development, so the webhook is an accelerator, not a requirement.
- **Grounding the call.** The first drafts of the task text let the model paraphrase the order. Reading the exact cart rows and total into the prompt fixed that.

## What I learned

Structured output changes what a phone call is. Once the result is a schema instead of a transcript, the call becomes a function the rest of the system can trust, with the same idempotency and review rules as any other write. The hard part is not dialing. It is deciding which answers are allowed to change a record on their own.

## What's next

Booking confirmations by default for clinics and salons, abandoned-cart callbacks, supplier stock checks over the phone, and Arabic locale support the moment CALL-E adds a Gulf or Levant region.

## Built since the hackathon opened

The phone tasks subsystem, its migration, routes, polling tick, webhook receiver, SDK client and portal pages were all written for this hackathon. The platform's brand-neutral core refactor also landed after 23 July 2026.

Repository: <https://github.com/TayseerLaz/frontdesk-core>
Submission PR: <https://github.com/CALLE-AI/awesome-phone-call-agents/pull/626>

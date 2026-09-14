# Video shoot list — exact clips

Target: under 3:00. One screen recording with your voice, phone on speaker beside the Mac so the
call audio lands in the same track. No music, no other companies' logos.

---

## Before you press record (10 minutes)

1. **Reset the demo data** so the call list is empty and the order is unconfirmed:
   ```bash
   cd ~/Projects/platform && set -a && . ./.env && set +a
   pnpm --filter @platform/db exec tsx --conditions=source scripts/seed-demo-clinic.ts
   ```
2. **Confirm live mode.** `.env` must have `CALLE_DRY_RUN=false`, `CALLE_API_KEY` set, and
   `CALLE_LIVE_OVERRIDE_PHONE` set to your Hushed number. Restart the API after any change:
   ```bash
   kill $(lsof -ti :4000); set -a && . ./.env && set +a
   pnpm --filter @platform/api dev
   ```
3. **Browser.** One window, one tab, `http://localhost:3000/app`, signed in as
   `calle@hackathon.com`. Hide bookmarks (`⌘⇧B`). Zoom to 110% (`⌘+`). Land on **Orders**.
4. **Phone.** Hushed app open, on **speaker**, volume up, lying beside the Mac.
5. **Recorder.** `⌘⇧5` → Record Entire Screen → Options → Microphone: built-in → Record.

---

## The six clips

### 1 · The problem — 20 seconds
**On screen:** the Orders list.

> "This is an AI front desk for a London skin clinic. The bot answers WhatsApp, takes bookings, and
> sells skincare. Every retail order here is cash on delivery, and that's the problem — there's no
> payment to prove the order is real, so someone has to phone every single one before the courier
> goes out."

### 2 · Start the call — 10 seconds
**Do:** point at Amelia Hart's £108.50 order sitting at `new`, then click **Confirm by phone**.

> "So let's have the AI do it. One click."

A toast confirms the call is queued. **Keep talking. Do not wait in silence.**

### 3 · Where the order came from — 30 seconds
**Do:** while it dials, click **View chat** on that row, or open Inbox → Amelia Hart.

> "While it dials — this is where the order came from. The customer asked for the vitamin C serum
> and the SPF, the bot priced them, took the address, and wrote a real order. And that's the
> important bit: the phone call is briefed from those order rows, not from the chatbot's own
> sentences. A model summarising a conversation will happily read back an item nobody ordered."

### 4 · The call — 50 seconds
**Do:** your phone rings. Answer on speaker. Let the AI read the items and the total. Confirm the
address. **Say yes with no changes.** Let it close the call naturally.

Say nothing over the top of it. The call is the demo.

### 5 · The write-back — 30 seconds
**Do:** go to **Phone tasks**. The row is `Completed`. Open it.

> "Here's what came back. Not a transcript in a log — a schema-validated result. Confirmed, address
> correct, confidence ninety-something percent, and the full transcript."

**Do:** go back to **Orders**. Amelia's row now reads `confirmed`.

> "The order moved on its own. And the summary was posted as a note in the customer's own WhatsApp
> thread, so the next person to open that conversation sees what was said on the phone."

### 6 · Safety, then close — 40 seconds
**Do:** back on **Phone tasks**, point at the green banner and the Automation card.

> "Two things make this safe to switch on. Dry run is the default, so the whole flow runs with no
> credentials and nothing dialled. And an order only moves on high confidence with an unambiguous
> answer. On my very first real call the tester asked to add an item mid-call — CALL-E returned
> 'changed', so the system refused to auto-confirm and sent it to a human instead. Low confidence
> can never cancel someone's order."

**Do:** flip the auto-confirm toggle on, briefly.

> "Turn this on and every new cash-on-delivery order gets the call by itself, with a delay and a
> daily cap. One file talks to CALL-E, results come back by webhook or by poll, and both land on a
> single idempotent write. Next up: abandoned carts, and supplier stock checks."

---

## After

1. Trim in QuickTime (`⌘T`), or iMovie if you need real cuts.
2. Upload to YouTube as **Public**, not Unlisted.
3. Send me the link. I add it to the pull request and the Devpost sheet.

## If a take goes wrong

Reset with the seed command in step 1 and go again. You have 19 CALL-E credits, so retakes are
cheap. If the AI says something you do not like, tell me and I will adjust the task wording in
`apps/api/src/lib/phone-tasks.ts` between takes.

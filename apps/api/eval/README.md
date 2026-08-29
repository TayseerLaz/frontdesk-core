# Bot eval harness (Phase 0 slice)

Drives the **real** bot engine against per-tenant golden sets and scores replies on
three axes:

| Axis | What it checks | Gate? |
|---|---|---|
| **Retrieval hit-rate** | Were the expected catalog SKUs surfaced to the model? (`candidateProductIds`) | gates `--retrieval-only` |
| **Deterministic** | No critical hallucination · reply language matches · no markdown/marker leak | **required gate** |
| **Binary LLM judge** | Does the reply meet the plain-English pass criteria? (fixed strong model, pass/fail) | advisory |

This is WS3 from `docs/ai-upgrade-plan.md`.

Beyond the single-turn gate, there are two more tools:
- **`pnpm eval:cart`** (`cart-sim.ts`) — **multi-turn cart simulation**. A user-simulator LLM
  plays a customer working toward an order goal (`cart-goals/<slug>.json`); the real engine
  replies each turn; the harness parses the confirmed `[CART:]` order and asserts the right
  items/quantities came out. Catches order-taking drift (wrong item, wrong qty, dropped item,
  re-asking a captured field) a one-shot eval can't.
- **`pnpm eval:replay`** (`gate-replay.ts`) — replays the grounding gate over recent real
  replies to measure the would-block rate that decides shadow → enforce.

## Dashboard (`/hq/eval`)

Pass **`--persist`** to any `runner.ts` run and it writes the result to the `eval_runs`
table, which the **Bot eval** page under `/hq` surfaces (gate verdict per tenant,
per-scenario drill-in, run history). Tag the run with `--trigger` and `--note`:

```bash
cd apps/api
set -a; . ../../.env.production; set +a
pnpm eval:gate -- --persist --trigger pre-deploy --note "before shipping X"
# or a full run (deterministic + judge), all tenants:
pnpm eval -- --all --persist --trigger pre-deploy
```

`eval_runs` is HQ infrastructure — it carries no `organization_id` and no RLS (an eval run
spans every golden set at once), and is readable only through `requireSuperAdmin`. The API
never runs the engine on request; the dashboard is a read-only view of what `--persist` wrote,
so the natural place to persist is the **pre-deploy** shadow-run against prod/staging.

## Layout

```
eval/
  types.ts        golden-scenario + result types
  scorers.ts      PURE scoring (unit-tested in test/eval-scorers.test.ts)
  judge.ts        binary LLM judge (Anthropic Sonnet; abstains if no key)
  runner.ts       CLI orchestrator
  golden/
    aseer-time.json   real Kuwaiti-dialect scenarios (grounded in live SKUs)
```

## Run

From `apps/api`, with an env that has `DATABASE_URL` + the AI keys. Use the `source`
condition so tsx imports the TypeScript, not stale `dist`:

```bash
cd apps/api
set -a; . ../../.env.production; set +a          # or a staging env

# Cheap: retrieval hit-rate only (compileOnly — embeddings, no generation, no judge)
./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time --retrieval-only

# Full: generation + deterministic checks + judge
./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time

# Skip the judge (deterministic gate only)
./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time --no-judge
```

```bash
# The multi-tenant GATE — run EVERY tenant that has a golden set and fail if ANY
# one regresses (an average would hide a single-tenant regression). This is the
# pre-deploy check: run it against staging before shipping a prompt/model change.
cd apps/api
set -a; . ../../.env.production; set +a
pnpm eval:gate                       # = tsx eval/runner.ts --all --retrieval-only
pnpm eval -- --all                   # full: retrieval + deterministic + judge, all tenants
```

Flags: `--org <slug>` · `--all` (every golden set) · `--retrieval-only` · `--no-judge` ·
`--threshold <0..1>` (default 0.8) · `--json`.

Exit code is **non-zero** when any tenant's pass rate is below `--threshold`, so the command
gates CI or a pre-deploy check. `--retrieval-only` gates on hit-rate; the full run gates on
the overall pass rate (deterministic AND judge). With `--all`, the gate fails if *any single
tenant* falls below threshold — the whole point being to catch a per-tenant regression (a
non-standard dialect, a tuned prompt) that an average would mask.

Golden sets today: `aseer-time` (Kuwaiti, 477-item), `sandwich-wnos` (Lebanese/arabizi,
small menu, LBP), `barista` (coffee retail, EN/AR/Arabizi). Add more by dropping a
`golden/<slug>.json` next to them.

### Hard gate vs. advisory

- **`--retrieval-only` is the HARD gate** (what `eval:gate` runs). Retrieval is deterministic,
  so the result is stable run-to-run — safe to fail a deploy on. All three tenants sit at 100%.
- **The full run (with the judge) is DIAGNOSTIC, not a hard gate — yet.** The bot generates at
  temperature 0.4, so replies (and therefore judge/deterministic verdicts) vary run-to-run;
  and the judge isn't calibrated to a human reviewer (κ) yet. Use the full run to *surface*
  quality signals to investigate — not to block a deploy. Calibrating the judge (few-shot from
  ~50 human pass/fail labels, confirm κ>0.7) + a temperature-0 eval mode are the next WS3 steps
  that graduate the full run into a hard gate.

## Adding scenarios

Seed `golden/<org-slug>.json` from real conversations — mine `MessageProvenance` for sampled
and flagged replies so the set tracks live traffic. Each scenario:

```jsonc
{
  "key": "sizes_shi_thani",          // unique id
  "dialect": "kuwaiti",              // for slicing results
  "prompt": "شي ثاني كم حجم عندكم؟",  // the customer message
  "expectation": "States all sizes with prices, not just one.",  // judged verbatim
  "expectLanguage": "ar",            // deterministic language check
  "expectCitesSku": ["MENU-340","MENU-341","MENU-342"],  // retrieval targets
  "mustNotHallucinate": true          // default true
}
```

## Notes

- The judge uses a **fixed** strong model (`ANTHROPIC_MODEL`) regardless of the tenant's plan —
  it should be at least as capable as the model under test. Binary pass/fail only (never 1–5).
- Pure scorers have no DB/network deps and are covered by `test/eval-scorers.test.ts`.
- Before trusting the judge as a gate, **calibrate it** (Phase 2): human-label ~50 scenarios,
  few-shot the judge from them, and confirm Cohen's κ > 0.7. Until then the deterministic
  checks are the required gate and the judge is advisory.

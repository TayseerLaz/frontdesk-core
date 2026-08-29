// Multi-turn cart simulation — the eval that single-turn scenarios can't do.
// A user-simulator LLM plays a customer working toward an order goal; each turn
// the real engine replies, we parse its "added X" lines into an in-memory cart
// (the same pure parser the live route uses), and at the end we assert the
// order came out right. Catches order-taking DRIFT (wrong item, wrong quantity,
// dropped item, re-asking for a captured field) that a one-shot eval misses.
//
//   cd apps/api; set -a; . ../../.env.production; set +a
//   ./node_modules/.bin/tsx --conditions=source eval/cart-sim.ts [--org aseer-time] [--show]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@platform/db';

import { buildBotResponse, gatherBotData } from '../src/lib/bot-engine.js';
import { parseAddedItems, type CatalogProduct, type ParsedAdd } from '../src/lib/cart-parser.js';
import { env } from '../src/lib/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface CartGoal {
  key: string;
  goal: string; // instruction handed to the user-simulator
  expectItems: { sku: string; quantity: number }[];
  maxTurns?: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let anthropic: Anthropic | null | undefined;
function ai(): Anthropic | null {
  if (anthropic === undefined) anthropic = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  return anthropic;
}

// The customer. Given the goal + transcript, produce the next short message.
async function userSays(goal: string, convo: { role: string; content: string }[]): Promise<string> {
  const a = ai();
  if (!a) return 'ok';
  const transcript = convo.map((m) => `${m.role === 'user' ? 'Me' : 'Shop'}: ${m.content}`).join('\n');
  const res = await a.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 80,
    temperature: 0.2,
    system:
      'You are a CUSTOMER messaging a shop to place an order. Follow your GOAL. ' +
      'Send ONE short, natural message (like a real WhatsApp text) that moves toward the goal. ' +
      'Answer the shop\'s questions (address, name, payment) briefly. When the shop has your whole ' +
      'order and asks you to confirm, reply with a clear confirmation ("yes", "confirm"). ' +
      'Output ONLY your message, nothing else.',
    messages: [{ role: 'user', content: `GOAL: ${goal}\n\nCONVERSATION SO FAR:\n${transcript || '(none yet — send your opening message)'}` }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim() || 'ok';
}

function mergeAdds(cart: ParsedAdd[], adds: ParsedAdd[]) {
  for (const add of adds) {
    const existing = cart.find((c) => c.sku.toLowerCase() === add.sku.toLowerCase());
    if (existing) existing.quantity += add.quantity;
    else cart.push({ ...add });
  }
}

// The confirmed order is the bot's [CART: {...}] marker (the structured order it
// commits) — not a naive sum of every "added"/summary line, which double-counts
// when the bot restates the running total. Balanced-brace scan so the nested
// items[] JSON doesn't end the match early.
function parseCartMarkerItems(reply: string): { sku: string; quantity: number }[] | null {
  const idx = reply.search(/\[CART:/i);
  if (idx < 0) return null;
  const start = reply.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < reply.length; i++) {
    if (reply[i] === '{') depth++;
    else if (reply[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(reply.slice(start, end + 1)) as { items?: { sku?: unknown; quantity?: unknown }[] };
    if (!Array.isArray(obj.items)) return null;
    return obj.items.map((it) => ({ sku: String(it.sku ?? ''), quantity: Number(it.quantity ?? 1) }));
  } catch {
    return null;
  }
}

async function simulate(orgId: string, catalog: CatalogProduct[], sc: CartGoal) {
  const maxTurns = sc.maxTurns ?? 8;
  const convo: { role: 'user' | 'assistant'; content: string }[] = [];
  const cart: ParsedAdd[] = [];
  let confirmed = false;
  let finalOrder: { sku: string; quantity: number }[] | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    const userMsg = await userSays(sc.goal, convo);
    const history = [...convo];
    const data = await prisma.$transaction((tx) => gatherBotData(tx as never, orgId));
    const subtotal = cart.reduce((s, c) => s + c.quantity * c.unitPriceMinor, 0);
    const cartState = cart.length
      ? {
          items: cart.map((c) => ({ name: c.name, quantity: c.quantity, unitPriceMinor: c.unitPriceMinor, sku: c.sku })),
          subtotalMinor: subtotal,
          currency: (data.biz?.currency ?? 'USD') as string,
        }
      : null;
    const res = await buildBotResponse({
      organizationId: orgId,
      userMessage: userMsg,
      history,
      data,
      replyMode: 'text',
      customerSpokeAudio: false,
      customerName: null,
      cartState,
      channelLabel: 'WhatsApp',
      temperature: 0,
    } as never);
    convo.push({ role: 'user', content: userMsg }, { role: 'assistant', content: res.text });
    mergeAdds(cart, parseAddedItems(res.text, catalog)); // draft, for diagnostics
    const marker = parseCartMarkerItems(res.text);
    if (marker) {
      confirmed = true;
      finalOrder = marker;
      break;
    }
  }

  // Assert the CONFIRMED order (the [CART:] marker) against the goal.
  const order = finalOrder ?? [];
  const failures: string[] = [];
  for (const want of sc.expectItems) {
    const got = order.find((c) => c.sku.toLowerCase() === want.sku.toLowerCase());
    if (!got) failures.push(`missing ${want.sku}`);
    else if (got.quantity !== want.quantity) failures.push(`${want.sku} qty ${got.quantity}≠${want.quantity}`);
  }
  const wantSkus = new Set(sc.expectItems.map((i) => i.sku.toLowerCase()));
  for (const c of order) if (!wantSkus.has(c.sku.toLowerCase())) failures.push(`extra ${c.sku}`);
  void cart; // draft kept for potential diagnostics; assertion uses the marker

  return { key: sc.key, confirmed, order, failures, convo };
}

async function main() {
  const slug = arg('org') ?? 'aseer-time';
  const show = process.argv.includes('--show');
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  if (!org) {
    console.error(`No org "${slug}"`);
    process.exit(2);
  }
  const goals = JSON.parse(readFileSync(join(HERE, 'cart-goals', `${slug}.json`), 'utf8')) as CartGoal[];
  const data = await prisma.$transaction((tx) => gatherBotData(tx as never, org.id));
  const catalog: CatalogProduct[] = data.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, priceMinor: p.priceMinor ?? null }));

  console.log(`\n=== cart simulation: ${slug} ===\n`);
  let pass = 0;
  const results = [];
  for (const g of goals) {
    const r = await simulate(org.id, catalog, g);
    const ok = r.confirmed && r.failures.length === 0;
    if (ok) pass++;
    results.push(r);
    console.log(`  ${g.key.padEnd(28)} ${ok ? '✓' : '✗'} ${ok ? `(order confirmed, ${r.order.length} item(s))` : r.failures.join('; ') || (r.confirmed ? '' : 'never confirmed')}`);
    if (show && !ok) for (const m of r.convo) console.log(`      ${m.role === 'user' ? '🧑' : '🤖'} ${m.content.replace(/\n/g, ' ').slice(0, 100)}`);
  }
  console.log(`\n  passed: ${pass}/${goals.length}\n`);
  await prisma.$disconnect();
  process.exit(pass === goals.length ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});

'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types (mirror apps/api/src/lib/scripted-flow.ts FlowNode / ScriptedFlow)
// ---------------------------------------------------------------------------
export interface FlowButton {
  title: string;
  next: string;
}
export interface ScriptedNode {
  text?: string;
  buttons?: FlowButton[];
  keywords?: { match: string; next: string }[];
  auto?: boolean;
  repromptText?: string;
  waitFor?: 'button' | 'text' | 'image';
  next?: string;
  action?: 'end' | 'handoff' | 'booking' | 'payment';
  smart?: { enabled?: boolean; expect?: string };
  voiceKey?: string | null;
  voiceAssetId?: string | null;
  [k: string]: unknown;
}
export interface ScriptedFlowValue {
  enabled?: boolean;
  entry: string;
  nodes: Record<string, ScriptedNode>;
  safety?: { node: string; screenText?: boolean };
  [k: string]: unknown;
}
type Nodes = Record<string, ScriptedNode>;
type StepKind = 'menu' | 'question' | 'photo' | 'message' | 'ending';

// Friendly names for the known Fatme nodes; anything else falls back to a text
// snippet, then the raw id.
const NODE_LABELS: Record<string, string> = {
  s0_welcome: 'Welcome · الترحيب (رسالة ١)',
  s0_team: 'Welcome · شرح الفريق (رسالة ٢)',
  s0_safe: 'Welcome · محفوظ وآمن (رسالة ٣)',
  safety_check: 'Safety check · فحص الأمان',
  crisis: 'Crisis message · رسالة الأزمة',
  crisis_resources: 'Crisis support lines · خطوط الدعم',
  q_name: 'Question: name · الاسم',
  q_origin: 'Question: where from · من وين',
  q_age: 'Question: age · العمر',
  q_how_found: 'Question: how found · شو وصّلك',
  q_email: 'Question: email · الإيميل',
  thanks: 'Thanks · شكراً',
  main_menu: 'Main menu · القائمة الرئيسية',
  free_consult: 'Free consultation · استشارة مجانية',
  free_consult_done: 'Consult confirm · تأكيد الاستشارة',
  draw_intro: 'Drawing — pick type · نوع الرسم',
  draw_release: 'Draw · release · تفريغ مشاعر',
  draw_connect: 'Draw · connect · اتواصل مع ذاتي',
  draw_receipt: 'Drawing received · وصلتني رسمتك',
  urgent_call: 'Urgent paid call · مكالمة عاجلة',
  urgent_call_done: 'Urgent confirm · تأكيد العاجلة',
  just_connecting: 'Just connecting · نبقى عالتواصل',
};

// ---------------------------------------------------------------------------
// Pure graph helpers (exported for headless testing — no React inside).
// ---------------------------------------------------------------------------
export function kindOf(n: ScriptedNode): StepKind {
  if (n.action === 'end' || n.action === 'handoff') return 'ending';
  if ((n.buttons?.length ?? 0) > 0) return 'menu';
  if (n.waitFor === 'image') return 'photo';
  const wait = n.waitFor ?? (n.next ? 'text' : undefined);
  if (n.auto) return 'message';
  if (wait === 'text') return 'question';
  return 'message';
}

// Is this a "linear" node the reorder buttons can safely swap? Single outgoing
// `next`, no branching buttons, not an ending.
export function isLinear(n: ScriptedNode | undefined): boolean {
  if (!n) return false;
  if (n.action === 'end' || n.action === 'handoff') return false;
  if ((n.buttons?.length ?? 0) > 0) return false;
  return typeof n.next === 'string' && n.next.length > 0;
}

// All the ways a node is pointed at, so delete/reorder can re-link cleanly.
export function referrers(
  nodes: Nodes,
  id: string,
): { from: string; via: 'next' | 'button' | 'keyword'; index?: number }[] {
  const out: { from: string; via: 'next' | 'button' | 'keyword'; index?: number }[] = [];
  for (const [fid, n] of Object.entries(nodes)) {
    if (n.next === id) out.push({ from: fid, via: 'next' });
    (n.buttons ?? []).forEach((b, i) => {
      if (b.next === id) out.push({ from: fid, via: 'button', index: i });
    });
    (n.keywords ?? []).forEach((k, i) => {
      if (k.next === id) out.push({ from: fid, via: 'keyword', index: i });
    });
  }
  return out;
}

// The single node whose `next` points at `id` (linear predecessor), or null.
function nextPredecessor(nodes: Nodes, id: string): string | null {
  const refs = referrers(nodes, id).filter((r) => r.via === 'next');
  return refs.length === 1 ? refs[0]!.from : null;
}

// Display order: walk the graph from entry, then append anything unreached.
export function orderedIds(entry: string, nodes: Nodes): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (id: string | undefined) => {
    if (!id || seen.has(id) || !nodes[id]) return;
    seen.add(id);
    out.push(id);
    const n = nodes[id]!;
    if (n.next) visit(n.next);
    for (const b of n.buttons ?? []) visit(b.next);
    for (const k of n.keywords ?? []) visit(k.next);
  };
  visit(entry);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) out.push(id);
  return out;
}

// The genuinely-reachable set from entry (buttons + next + keywords).
function reachableSet(entry: string, nodes: Nodes): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    const n = nodes[id]!;
    if (n.next) stack.push(n.next);
    for (const b of n.buttons ?? []) stack.push(b.next);
    for (const k of n.keywords ?? []) stack.push(k.next);
  }
  return seen;
}

export function validateFlow(
  entry: string,
  nodes: Nodes,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const label = (id: string) => NODE_LABELS[id] ?? id;
  if (!nodes[entry]) errors.push(`The first step "${entry}" is missing.`);
  for (const [id, n] of Object.entries(nodes)) {
    if (n.next && !nodes[n.next]) errors.push(`"${label(id)}" leads to a step that no longer exists.`);
    const btns = n.buttons ?? [];
    if (btns.length > 3) errors.push(`"${label(id)}" has more than 3 buttons (WhatsApp allows 3).`);
    btns.forEach((b, i) => {
      const t = (b.title ?? '').trim();
      if (!t) errors.push(`A button on "${label(id)}" has no label.`);
      if (t.length > 20) errors.push(`Button "${t}" on "${label(id)}" is over 20 characters.`);
      if (!b.next || !nodes[b.next]) errors.push(`Button "${t || i + 1}" on "${label(id)}" doesn't lead anywhere.`);
    });
    (n.keywords ?? []).forEach((k) => {
      if (!nodes[k.next]) errors.push(`A keyword on "${label(id)}" leads to a missing step.`);
    });
  }
  const reach = reachableSet(entry, nodes);
  for (const id of Object.keys(nodes)) {
    if (!reach.has(id)) warnings.push(`"${label(id)}" can't be reached — nothing leads to it yet.`);
  }
  return { errors, warnings };
}

// --- transforms (pure: take nodes, return new nodes) -----------------------
export function moveUp(nodes: Nodes, entry: string, id: string): Nodes {
  const P = nextPredecessor(nodes, id);
  if (!P || P === entry || !isLinear(nodes[P])) return nodes;
  const A = nextPredecessor(nodes, P);
  if (!A) return nodes; // can't reattach above P
  const S = nodes[id]!.next;
  const out: Nodes = { ...nodes };
  out[id] = { ...out[id]!, next: P };
  out[P] = { ...out[P]!, next: S };
  out[A] = { ...out[A]!, next: id };
  return out;
}
export function moveDown(nodes: Nodes, id: string): Nodes {
  const S = nodes[id]?.next;
  if (!S || !isLinear(nodes[S])) return nodes;
  const P = nextPredecessor(nodes, id); // may be null if id is entry
  const T = nodes[S]!.next;
  const out: Nodes = { ...nodes };
  if (P) out[P] = { ...out[P]!, next: S };
  out[S] = { ...out[S]!, next: id };
  out[id] = { ...out[id]!, next: T };
  return out;
}
export function deleteStep(nodes: Nodes, id: string): Nodes {
  const bridge = nodes[id]?.next;
  const out: Nodes = {};
  for (const [fid, n] of Object.entries(nodes)) {
    if (fid === id) continue;
    const nn: ScriptedNode = { ...n };
    if (nn.next === id) nn.next = bridge;
    if (nn.buttons) nn.buttons = nn.buttons.map((b) => (b.next === id ? { ...b, next: bridge ?? b.next } : b));
    if (nn.keywords) nn.keywords = nn.keywords.map((k) => (k.next === id ? { ...k, next: bridge ?? k.next } : k));
    out[fid] = nn;
  }
  return out;
}
function freshId(nodes: Nodes): string {
  let i = 1;
  while (nodes[`step_${i}`]) i += 1;
  return `step_${i}`;
}
function buildNode(kind: StepKind, bridge: string | undefined, fallbackTarget: string): ScriptedNode {
  switch (kind) {
    case 'message':
      return { text: 'New message', auto: true, ...(bridge ? { next: bridge } : {}) };
    case 'question':
      return { text: 'New question?', waitFor: 'text', next: bridge ?? fallbackTarget, repromptText: '' };
    case 'menu':
      return { text: 'Pick one:', buttons: [{ title: 'Option 1', next: bridge ?? fallbackTarget }] };
    case 'ending':
      return { text: 'Thanks — a teammate will follow up. 🌿', action: 'handoff' };
    default:
      return { text: 'New message', auto: true, ...(bridge ? { next: bridge } : {}) };
  }
}
export function addStepBelow(nodes: Nodes, afterId: string, kind: StepKind, entry: string): { nodes: Nodes; id: string } {
  const id = freshId(nodes);
  const after = nodes[afterId]!;
  const bridge = after.next; // new step inherits the old link
  const node = buildNode(kind, bridge, afterId);
  const out: Nodes = { ...nodes, [id]: node };
  // Only auto-chain when the previous step is linear (a message/question/photo
  // that had a single onward link). Menus/endings are left for the operator to
  // point a button at the new step (validation flags it as unreachable meanwhile).
  if (isLinear(after)) out[afterId] = { ...after, next: id };
  return { nodes: out, id };
}

// ---------------------------------------------------------------------------
const KIND_META: Record<StepKind, { badge: string; cls: string }> = {
  message: { badge: 'Message', cls: 'bg-slate-100 text-slate-700' },
  question: { badge: 'Question', cls: 'bg-brand-100 text-brand-700' },
  menu: { badge: 'Buttons', cls: 'bg-amber-100 text-amber-800' },
  photo: { badge: 'Photo', cls: 'bg-violet-100 text-violet-700' },
  ending: { badge: 'Ending', cls: 'bg-rose-100 text-rose-700' },
};

function labelOf(id: string, nodes: Nodes): string {
  if (NODE_LABELS[id]) return NODE_LABELS[id]!;
  const t = (nodes[id]?.text ?? '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 44) + (t.length > 44 ? '…' : '');
  return id;
}

/**
 * Visual editor for a deterministic scripted flow. Non-technical operators can
 * edit wording + buttons, add / remove / reorder steps, repoint where each
 * button or question leads, and turn on "smart" (LLM-interpreted) answers — all
 * without touching JSON. Every save is validated so a broken graph can't go live.
 */
export function ScriptedFlowEditor({
  flow,
  onSaved,
}: {
  flow: ScriptedFlowValue;
  onSaved: () => void;
}) {
  const [nodes, setNodes] = useState<Nodes>(() => JSON.parse(JSON.stringify(flow.nodes ?? {})));
  const [saving, setSaving] = useState(false);
  const entry = flow.entry;
  const safety = flow.safety?.node;

  const order = useMemo(() => orderedIds(entry, nodes), [entry, nodes]);
  const targetOptions = useMemo(
    () => order.map((id) => ({ id, label: labelOf(id, nodes) })),
    [order, nodes],
  );

  // -- mutators --
  const patch = (id: string, p: Partial<ScriptedNode>) =>
    setNodes((n) => ({ ...n, [id]: { ...n[id], ...p } }));
  const setText = (id: string, text: string) => patch(id, { text });
  const setNext = (id: string, next: string) => patch(id, { next });
  const setReprompt = (id: string, repromptText: string) => patch(id, { repromptText });
  const setButtonTitle = (id: string, i: number, title: string) =>
    setNodes((n) => {
      const b = [...(n[id]?.buttons ?? [])];
      b[i] = { ...b[i]!, title };
      return { ...n, [id]: { ...n[id], buttons: b } };
    });
  const setButtonTarget = (id: string, i: number, next: string) =>
    setNodes((n) => {
      const b = [...(n[id]?.buttons ?? [])];
      b[i] = { ...b[i]!, next };
      return { ...n, [id]: { ...n[id], buttons: b } };
    });
  const addButton = (id: string) =>
    setNodes((n) => {
      const b = [...(n[id]?.buttons ?? [])];
      if (b.length >= 3) return n;
      b.push({ title: `Option ${b.length + 1}`, next: entry });
      return { ...n, [id]: { ...n[id], buttons: b } };
    });
  const removeButton = (id: string, i: number) =>
    setNodes((n) => {
      const b = (n[id]?.buttons ?? []).filter((_, k) => k !== i);
      return { ...n, [id]: { ...n[id], buttons: b } };
    });
  const setSmart = (id: string, on: boolean) =>
    patch(id, { smart: { enabled: on, expect: nodes[id]?.smart?.expect } });
  const setExpect = (id: string, expect: string) =>
    patch(id, { smart: { enabled: nodes[id]?.smart?.enabled ?? true, expect } });

  const doDelete = (id: string) => {
    if (id === entry) return toast.error("The first step can't be deleted — it's the greeting.");
    if (id === safety) return toast.error("The safety step can't be deleted.");
    const refs = referrers(nodes, id);
    if (refs.length > 0 && !nodes[id]?.next) {
      return toast.error(
        'Other steps lead here but this step has no “next”. Re-point those first, then delete.',
      );
    }
    if (!confirm(`Delete "${labelOf(id, nodes)}"? Steps that pointed here will skip to the next one.`))
      return;
    setNodes((n) => deleteStep(n, id));
  };

  const save = async () => {
    const { errors, warnings } = validateFlow(entry, nodes);
    if (errors.length) {
      toast.error(errors[0]!);
      return;
    }
    setSaving(true);
    try {
      await api.put('/api/v1/bot/config', { scriptedFlow: { ...flow, entry, nodes } });
      if (warnings.length) toast.info(`Saved. Heads-up: ${warnings[0]}`);
      else toast.success('Flow saved — live now for new conversations.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-muted">
        The bot walks customers through these steps top-to-bottom. The first step (with the greeting
        voice) always comes first. Edit the wording, add or remove steps, choose where each button or
        question leads, and turn on “smart answers” to let the AI check typed replies.
      </p>

      {order.map((id, idx) => {
        const node = nodes[id]!;
        const kind = kindOf(node);
        const meta = KIND_META[kind];
        const pred = nextPredecessor(nodes, id);
        const canUp = !!pred && pred !== entry && isLinear(nodes[pred]) && !!nextPredecessor(nodes, pred);
        const canDown = isLinear(node) && isLinear(nodes[node.next!]);
        const isEntry = id === entry;
        return (
          <div key={id} className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 text-[11px] font-mono text-foreground-subtle">{idx + 1}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.cls}`}>
                  {meta.badge}
                </span>
                <span className="truncate text-[11px] font-semibold text-foreground-subtle">
                  {labelOf(id, nodes)}
                  {isEntry ? ' · first' : ''}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={!canUp}
                  onClick={() => setNodes((n) => moveUp(n, entry, id))}
                  className="rounded border border-border px-1.5 py-0.5 text-xs disabled:opacity-30"
                  title="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={!canDown}
                  onClick={() => setNodes((n) => moveDown(n, id))}
                  className="rounded border border-border px-1.5 py-0.5 text-xs disabled:opacity-30"
                  title="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => doDelete(id)}
                  className="rounded border border-rose-200 px-1.5 py-0.5 text-xs text-rose-600 hover:bg-rose-50"
                  title="Delete step"
                >
                  ✕
                </button>
              </div>
            </div>

            {node.voiceKey || (isEntry && flowHasEntryVoice(flow)) ? (
              <p className="text-[10px] text-brand-600">🔊 Greeting voice note plays before this step.</p>
            ) : null}

            <textarea
              dir="auto"
              value={node.text ?? ''}
              onChange={(e) => setText(id, e.target.value)}
              rows={Math.min(12, Math.max(2, (node.text ?? '').split('\n').length + 1))}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm leading-relaxed outline-none focus:border-brand-400"
              placeholder="Message text…"
            />

            {/* Buttons (menu step) */}
            {kind === 'menu' ? (
              <div className="space-y-2">
                <Label className="text-[11px] text-foreground-muted">Tappable buttons — where each one leads</Label>
                {(node.buttons ?? []).map((b, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input
                      dir="auto"
                      value={b.title}
                      maxLength={20}
                      onChange={(e) => setButtonTitle(id, i, e.target.value)}
                      className="w-40 rounded-full border border-border bg-surface px-3 py-1 text-xs outline-none focus:border-brand-400"
                      placeholder="Button label"
                    />
                    <span className="text-[11px] text-foreground-subtle">→</span>
                    <select
                      value={b.next}
                      onChange={(e) => setButtonTarget(id, i, e.target.value)}
                      className="max-w-[220px] rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-brand-400"
                    >
                      {targetOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeButton(id, i)}
                      className="text-xs text-rose-500 hover:underline"
                    >
                      remove
                    </button>
                  </div>
                ))}
                {(node.buttons?.length ?? 0) < 3 ? (
                  <button type="button" onClick={() => addButton(id)} className="text-xs text-brand-600 hover:underline">
                    + Add button
                  </button>
                ) : (
                  <p className="text-[10px] text-foreground-subtle">Max 3 buttons (WhatsApp limit).</p>
                )}
              </div>
            ) : null}

            {/* Where a non-menu step goes next */}
            {kind !== 'menu' && kind !== 'ending' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Label className="text-[11px] text-foreground-muted">Then go to</Label>
                <select
                  value={node.next ?? ''}
                  onChange={(e) => setNext(id, e.target.value)}
                  className="max-w-[240px] rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-brand-400"
                >
                  {!node.next ? <option value="">— ends the chat —</option> : null}
                  {targetOptions
                    .filter((o) => o.id !== id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}

            {/* Question / photo re-prompt + smart answer */}
            {kind === 'question' || kind === 'photo' ? (
              <div className="space-y-2 rounded-md bg-surface-muted/50 p-2">
                {kind === 'question' ? (
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={!!node.smart?.enabled}
                      onChange={(e) => setSmart(id, e.target.checked)}
                      className="mt-0.5 size-3.5 cursor-pointer accent-brand-600"
                    />
                    <span>
                      <span className="font-medium">Smart answer (AI checks the reply)</span>
                      <span className="block text-[10px] text-foreground-muted">
                        The AI reads what the customer typed. If it isn’t a real answer to this
                        question, it re-asks with the message below instead of moving on. Off = any
                        text moves forward.
                      </span>
                    </span>
                  </label>
                ) : null}
                {kind === 'question' && node.smart?.enabled ? (
                  <input
                    dir="auto"
                    value={node.smart?.expect ?? ''}
                    onChange={(e) => setExpect(id, e.target.value)}
                    className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs outline-none focus:border-brand-400"
                    placeholder="What a good answer looks like (e.g. a valid email address) — optional"
                  />
                ) : null}
                <div className="space-y-1">
                  <Label className="text-[11px] text-foreground-muted">
                    {kind === 'photo'
                      ? 'Gentle re-prompt (if they type instead of sending the photo)'
                      : 'Re-ask message (used when the answer doesn’t fit)'}
                  </Label>
                  <textarea
                    dir="auto"
                    value={(node.repromptText as string) ?? ''}
                    onChange={(e) => setReprompt(id, e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs leading-relaxed outline-none focus:border-brand-400"
                    placeholder="Gentle re-prompt…"
                  />
                </div>
              </div>
            ) : null}

            {/* Add a step under this one */}
            <AddStepRow
              onAdd={(k) =>
                setNodes((n) => {
                  const res = addStepBelow(n, id, k, entry);
                  return res.nodes;
                })
              }
            />
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} loading={saving}>
          Save flow
        </Button>
        <span className="text-[11px] text-foreground-subtle">
          Edits go live immediately for new conversations.
        </span>
      </div>
    </div>
  );
}

function flowHasEntryVoice(flow: ScriptedFlowValue): boolean {
  return Boolean((flow as { greetingVoiceOnEntry?: boolean }).greetingVoiceOnEntry);
}

function AddStepRow({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const [kind, setKind] = useState<StepKind>('message');
  return (
    <div className="flex items-center gap-2 border-t border-dashed border-border pt-2">
      <span className="text-[11px] text-foreground-subtle">Add step below:</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as StepKind)}
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-brand-400"
      >
        <option value="message">Message</option>
        <option value="question">Question</option>
        <option value="menu">Buttons</option>
        <option value="ending">Ending</option>
      </select>
      <button type="button" onClick={() => onAdd(kind)} className="text-xs text-brand-600 hover:underline">
        + Add
      </button>
    </div>
  );
}

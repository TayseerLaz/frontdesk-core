// Deterministic scripted-flow engine.
//
// A guided, button-driven state machine that runs BEFORE the LLM in the WhatsApp
// inbound path. When a tenant has an ENABLED BotConfig.scriptedFlow, the bot no
// longer generates replies — it sends the operator's EXACT text + tappable
// buttons and advances node-by-node on each tap/answer, guaranteeing verbatim
// wording and strict branching (used by tenants whose bot is a scripted intake
// flow, not a Q&A / shop bot).
//
// Content lives entirely in the DB (BotConfig.scriptedFlow), so refining a
// message is a data update, not a redeploy. This module is the stable engine.
import { withTenant } from './db.js';

// ---------- flow definition (stored as JSON on BotConfig.scriptedFlow) -------
export interface FlowButton {
  title: string; // ≤ 20 chars (WhatsApp button limit), rendered as a tap-button
  next: string; // node id to go to when tapped
}
export interface FlowKeyword {
  match: string; // case-insensitive substring the customer might type
  next: string;
}
export interface FlowNode {
  // Message text to send for this node (may be multi-line). Optional for
  // action-only nodes.
  text?: string;
  // Optional voice note sent BEFORE the text — by Wasabi storage key (preferred,
  // matches the bot-builder upload) or by Asset id.
  voiceKey?: string | null;
  voiceAssetId?: string | null;
  // Tap-buttons (max 3 on WhatsApp). Presence implies waitFor:'button'.
  buttons?: FlowButton[];
  // Typed-keyword shortcuts (checked when the node waits on a button but the
  // customer types instead — e.g. a menu's merged 4th option).
  keywords?: FlowKeyword[];
  // Auto-advance: after sending this node's message(s), immediately continue to
  // `next` WITHOUT waiting for the customer. Used to emit several bubbles in a
  // row (e.g. a multi-line welcome) that feel like a natural WhatsApp burst.
  // Ignored when the node has buttons (those always wait for a tap).
  auto?: boolean;
  // Short message sent when the customer's input doesn't satisfy this node's
  // wait (e.g. they type a question instead of sending the drawing). Sent
  // INSTEAD of re-running the whole node — so a node's voice note / long text
  // isn't resent every time. Currently applied to the 'image' wait.
  repromptText?: string;
  // Smart (LLM-interpreted) free-text answer. When enabled on a text-wait node,
  // the typed answer is validated by a cheap LLM against the question before the
  // flow advances; if it doesn't satisfy `expect`, the node's repromptText (or
  // the question itself) is re-sent and the flow stays put — so "what's your
  // email?" won't advance on "idk". Fail-OPEN: any LLM error accepts the answer
  // (never trap the customer on an API blip). Off by default = any text advances.
  smart?: { enabled?: boolean; expect?: string };
  // What advances the flow from here. Defaults: 'button' if buttons present,
  // else 'text' if `next` present, else the node ends the flow.
  waitFor?: 'button' | 'text' | 'image';
  // Where to go on a text answer / an image / an auto-advance.
  next?: string;
  // Side effect on entering this node.
  action?: 'end' | 'handoff' | 'booking' | 'payment';
  // For action 'booking': a booking URL appended to the message.
  bookingUrl?: string | null;
}
export interface ScriptedFlow {
  enabled?: boolean;
  channel?: string; // 'whatsapp'
  entry: string; // entry node id
  nodes: Record<string, FlowNode>;
  // Opt-in AI distress pre-check. When screenText is true, each free-text
  // inbound is screened for acute distress / self-harm (fast LLM + keyword
  // backstop) BEFORE the scripted intake runs; a positive diverts to `node`
  // and a human handoff. Omit / undefined = no screening (pure deterministic).
  safety?: { node: string; screenText?: boolean };
  // When true, the configured greeting voice note (BotConfig.greetingVoiceStorageKey)
  // plays automatically at the ENTRY node. Leave off for flows that place the
  // voice on a specific later node (e.g. an S6 audio task) — otherwise it would
  // play twice (at the welcome AND that node).
  greetingVoiceOnEntry?: boolean;
}
interface FlowState {
  nodeId: string;
  done?: boolean;
  answers?: string[];
}

const GRAPH = 'https://graph.facebook.com/v25.0';
const MAX_CHAIN = 10; // safety bound on auto-advance chaining (multi-bubble bursts)

export interface FlowChannel {
  id: string;
  phoneNumberId: string | null;
  accessToken: string | null;
}
export interface FlowInbound {
  from: string;
  type: string; // 'text' | 'interactive' | 'button' | 'image' | ...
  bodyText: string | null; // for interactive/button this is the tapped title
  mediaId?: string | null;
}
type Logger = {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
};

function parseFlow(raw: unknown): ScriptedFlow | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as ScriptedFlow;
  if (!f.enabled) return null;
  if (!f.entry || !f.nodes || typeof f.nodes !== 'object') return null;
  if (!f.nodes[f.entry]) return null;
  return f;
}
function parseState(raw: unknown): FlowState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as FlowState;
  if (typeof s.nodeId !== 'string') return null;
  return s;
}

/**
 * Handle one inbound WhatsApp message with the tenant's scripted flow.
 * Returns true if the flow handled it (the caller MUST then skip the LLM);
 * false if there's no active flow and the normal bot should run.
 */
export async function runScriptedFlow(args: {
  organizationId: string;
  channel: FlowChannel;
  thread: { id: string; flowState: unknown };
  scriptedFlow: unknown;
  // Greeting voice note (BotConfig.greetingVoiceStorageKey) — played before the
  // entry node's text when that node has no explicit voice of its own.
  greetingVoiceKey?: string | null;
  message: FlowInbound;
  log: Logger;
}): Promise<boolean> {
  const flow = parseFlow(args.scriptedFlow);
  if (!flow) return false;
  if (flow.channel && flow.channel !== 'whatsapp') return false;
  if (!args.channel.phoneNumberId || !args.channel.accessToken) return false;

  const sendText = async (body: string): Promise<void> => {
    await postAndPersist(args, { type: 'text', text: { preview_url: true, body: body.slice(0, 4096) } }, body, []);
  };
  const sendButtons = async (body: string, buttons: FlowButton[]): Promise<void> => {
    const btns = buttons.slice(0, 3);
    await postAndPersist(
      args,
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body.slice(0, 1024) },
          action: {
            buttons: btns.map((b, i) => ({
              type: 'reply',
              reply: { id: `flow_${i}`, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
      body,
      btns.map((b) => b.title),
    );
  };

  // Send a node's message(s) + run its side effect. Returns the NEXT state's
  // nodeId to persist, and whether the flow is now waiting for input (stop) or
  // should keep chaining.
  const enterNode = async (
    nodeId: string,
  ): Promise<{ nodeId: string; done: boolean; waiting: boolean }> => {
    const node = flow.nodes[nodeId];
    if (!node) {
      args.log.warn({ nodeId }, '[flow] missing node — ending');
      return { nodeId, done: true, waiting: false };
    }
    // Optional voice note first. Explicit per-node voice wins. The ENTRY node
    // plays the configured greeting voice note (bot-builder upload) ONLY when the
    // flow opts in via greetingVoiceOnEntry — otherwise a flow that places the
    // voice on a later node (e.g. fatme's S6 audio task) would double-play it at
    // the welcome AND that node.
    const voiceKey =
      node.voiceKey ??
      (node.voiceAssetId ? await resolveAssetKey(args, node.voiceAssetId) : null) ??
      (flow.greetingVoiceOnEntry && nodeId === flow.entry ? args.greetingVoiceKey ?? null : null);
    if (voiceKey) {
      await sendVoiceByKey(args, voiceKey).catch((err) =>
        args.log.warn({ err, nodeId }, '[flow] voice send failed (continuing)'),
      );
    }
    // Compose the text (booking URL appended when configured).
    let body = node.text ?? '';
    if (node.action === 'booking' && node.bookingUrl) {
      body = body ? `${body}\n\n${node.bookingUrl}` : node.bookingUrl;
    }
    const buttons = node.buttons ?? [];
    if (body || buttons.length > 0) {
      if (buttons.length > 0) await sendButtons(body || '👇', buttons);
      else await sendText(body);
    }
    // Side effects.
    if (node.action === 'handoff') {
      await markThreadPending(args).catch(() => undefined);
    }
    // Decide what happens next.
    if (node.action === 'end') return { nodeId, done: true, waiting: false };
    // Explicit auto-advance (multi-bubble bursts): sent already, keep going.
    if (node.auto && node.next && buttons.length === 0)
      return { nodeId: node.next, done: false, waiting: false };
    const waitFor = node.waitFor ?? (buttons.length > 0 ? 'button' : node.next ? 'text' : undefined);
    if (waitFor) return { nodeId, done: false, waiting: true };
    if (node.next) return { nodeId: node.next, done: false, waiting: false }; // auto-advance
    return { nodeId, done: true, waiting: false }; // terminal node with no next
  };

  // Advance through auto-chaining nodes until one waits for input or the flow
  // ends, then persist the resting state.
  const settle = async (startNodeId: string, answers: string[]): Promise<void> => {
    let cur = startNodeId;
    let done = false;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const r = await enterNode(cur);
      cur = r.nodeId;
      if (r.done) {
        done = true;
        break;
      }
      if (r.waiting) break;
    }
    await saveState(args, { nodeId: cur, done, answers });
  };

  // Re-prompt WITHOUT re-running the node: send its short repromptText (if set)
  // and stay put, so a node's voice note / long body isn't resent on every
  // wrong input. Falls back to fully re-entering the node when none is set.
  const reprompt = async (nodeId: string, answers: string[]): Promise<void> => {
    const n = flow.nodes[nodeId];
    if (n?.repromptText) {
      await sendText(n.repromptText);
      await saveState(args, { nodeId, done: false, answers });
      return;
    }
    await settle(nodeId, answers);
  };

  const state = parseState(args.thread.flowState);

  // ---- AI distress pre-check (opt-in via flow.safety.screenText) -----------
  // Screen free-text for acute distress BEFORE the intake proceeds and divert
  // to the safety node + human handoff. Taps/images aren't screened; a
  // completed (handed-off) conversation stays silent.
  const screenInbound = (args.message.bodyText ?? '').trim();
  if (
    flow.safety?.screenText &&
    flow.safety.node &&
    flow.nodes[flow.safety.node] &&
    args.message.type === 'text' &&
    screenInbound &&
    !state?.done
  ) {
    const distress = await screenDistress(args.organizationId, screenInbound, args.log);
    if (distress) {
      args.log.warn(
        { orgId: args.organizationId, node: flow.safety.node },
        '[flow] distress detected — diverting to safety + handoff',
      );
      await settle(flow.safety.node, state?.answers ?? []);
      return true;
    }
  }

  // ---- Fresh start: no state, or a previous run already finished ----
  if (!state || state.done) {
    // If the flow already completed for this conversation, stay silent (the
    // operator follows up) rather than restarting the whole intake. Logged so a
    // "bot not replying" report on a re-used test thread is diagnosable.
    if (state?.done) {
      args.log.info(
        { orgId: args.organizationId, threadId: args.thread.id, node: state.nodeId },
        '[flow] already completed for this thread — staying silent (handed off to human)',
      );
      return true;
    }
    args.log.info(
      { orgId: args.organizationId, threadId: args.thread.id, entry: flow.entry },
      '[flow] fresh start — running entry node',
    );
    await settle(flow.entry, []);
    return true;
  }

  // ---- Mid-flow: process the customer's input at the current node ----
  const node = flow.nodes[state.nodeId];
  if (!node) {
    await settle(flow.entry, state.answers ?? []); // corrupt state → restart cleanly
    return true;
  }
  const isTap = args.message.type === 'interactive' || args.message.type === 'button';
  const tapped = (args.message.bodyText ?? '').trim();
  const text = (args.message.bodyText ?? '').trim();
  const isImage = args.message.type === 'image';
  const effectiveWait = node.waitFor ?? (node.buttons?.length ? 'button' : node.next ? 'text' : undefined);

  // Keyword shortcuts work regardless of what the node waits on.
  if (node.keywords && text) {
    const low = text.toLowerCase();
    const kw = node.keywords.find((k) => low.includes(k.match.toLowerCase()));
    if (kw) {
      await settle(kw.next, state.answers ?? []);
      return true;
    }
  }

  if (effectiveWait === 'button') {
    const match =
      (isTap && node.buttons?.find((b) => b.title === tapped)) ||
      node.buttons?.find((b) => b.title === text) ||
      null;
    if (match) {
      await settle(match.next, state.answers ?? []);
      return true;
    }
    // Didn't tap a known button — re-show the current node so they can choose.
    await settle(state.nodeId, state.answers ?? []);
    return true;
  }

  if (effectiveWait === 'image') {
    if (isImage && node.next) {
      await settle(node.next, state.answers ?? []);
      return true;
    }
    // Gently re-anchor for the drawing (short repromptText — not the whole node,
    // so the audio task / long instructions aren't resent).
    await reprompt(state.nodeId, state.answers ?? []);
    return true;
  }

  if (effectiveWait === 'text') {
    // Smart (LLM-interpreted) answers: validate BEFORE recording/advancing. On a
    // non-answer, re-ask (repromptText or the question) and stay put — the bad
    // input is NOT appended to answers. Fail-open inside validateSmartAnswer.
    if (node.smart?.enabled && text) {
      const ok = await validateSmartAnswer(args.organizationId, node, text, args.log);
      if (!ok) {
        await reprompt(state.nodeId, state.answers ?? []);
        return true;
      }
    }
    const answers = [...(state.answers ?? []), text].filter(Boolean);
    if (node.next) {
      await settle(node.next, answers);
      return true;
    }
    await saveState(args, { nodeId: state.nodeId, done: true, answers });
    return true;
  }

  // No wait defined (shouldn't happen mid-flow) — re-enter to be safe.
  await settle(state.nodeId, state.answers ?? []);
  return true;
}

// ---------- AI distress pre-check --------------------------------------------
// A tiny keyword backstop (works even if the LLM is down) short-circuits to
// true on explicit self-harm phrases; otherwise a cheap Haiku JSON classifier
// decides. Any failure → false (never block the intake on an API blip), logged.
const DISTRESS_KEYWORDS = [
  'بدي موت', 'بموت', 'بدي انتحر', 'انتحار', 'اقتل حالي', 'اقتل نفسي', 'قتل نفسي',
  'اذي حالي', 'اذية نفسي', 'ما بدي عيش', 'ما عاد بدي عيش', 'مابدي عيش', 'خلص حياتي',
  'kill myself', 'suicide', 'suicidal', 'want to die', 'wanna die', 'end my life',
  'end it all', 'self harm', 'self-harm', 'hurt myself', 'harming myself',
];
async function screenDistress(orgId: string, text: string, log: Logger): Promise<boolean> {
  const low = text.toLowerCase();
  if (DISTRESS_KEYWORDS.some((k) => low.includes(k.toLowerCase()))) return true;
  try {
    const { completeFast } = await import('./openai.js');
    const r = await completeFast<{ distress?: boolean }>({
      organizationId: orgId,
      systemPrompt:
        'You are a safety classifier for a warm Levantine-Arabic intake bot. Decide if the user message expresses ACUTE distress: suicidal thoughts, wanting to die, self-harm, being abused or in danger right now, or an active mental-health crisis. Ordinary sadness, stress, tiredness, or venting is NOT acute. Answer ONLY as minified JSON {"distress": true|false}.',
      userContent: text.slice(0, 800),
      maxTokens: 12,
      temperature: 0,
    });
    return r?.distress === true;
  } catch (err) {
    log.warn({ err }, '[flow] distress screen failed — continuing intake');
    return false;
  }
}

// ---------- smart (LLM-interpreted) answer validation ------------------------
// Decide whether a typed answer actually answers the node's question. Used only
// when node.smart.enabled. Cheap Haiku JSON classifier; ANY failure → true
// (fail-open, never trap the customer). The question is the node's own text; an
// optional node.smart.expect describes what a good answer looks like.
async function validateSmartAnswer(
  orgId: string,
  node: FlowNode,
  answer: string,
  log: Logger,
): Promise<boolean> {
  const question = (node.text ?? '').slice(0, 500);
  const expect = (node.smart?.expect ?? '').slice(0, 300);
  try {
    const { completeFast } = await import('./openai.js');
    const r = await completeFast<{ valid?: boolean }>({
      organizationId: orgId,
      systemPrompt:
        'You validate whether a user\'s reply genuinely answers a question in a chat intake flow. ' +
        'Be LENIENT: accept any plausible, good-faith answer (any language, short forms, typos). ' +
        'Reject ONLY clear non-answers: empty, gibberish, "idk"/"لا اعرف", a question back, or an off-topic reply, ' +
        'or an answer of the WRONG KIND (e.g. a name where an email address was asked for). ' +
        (expect ? `A valid answer should be: ${expect}. ` : '') +
        'Answer ONLY as minified JSON {"valid": true|false}.',
      userContent: `Question: ${question}\nUser reply: ${answer.slice(0, 500)}`,
      maxTokens: 12,
      temperature: 0,
    });
    // Undefined/unknown → accept (fail-open).
    return r?.valid !== false;
  } catch (err) {
    log.warn({ err }, '[flow] smart-answer validation failed — accepting');
    return true;
  }
}

// ---------- side effects / persistence --------------------------------------
async function postAndPersist(
  args: {
    organizationId: string;
    channel: FlowChannel;
    thread: { id: string };
    message: FlowInbound;
    log: Logger;
  },
  content: Record<string, unknown>,
  body: string,
  quickReplies: string[],
): Promise<void> {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: args.message.from,
    ...content,
  };
  let metaId: string | null = null;
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(args.channel.phoneNumberId!)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.channel.accessToken!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const t = await res.text();
    if (!res.ok) {
      args.log.error({ status: res.status, body: t.slice(0, 300) }, '[flow] Meta send failed');
      return;
    }
    metaId = (JSON.parse(t) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
  } catch (err) {
    args.log.error({ err }, '[flow] Meta send threw');
    return;
  }
  // Persist so the message shows in the inbox thread.
  await withTenant(args.organizationId, async (tx) => {
    await tx.whatsAppMessage.create({
      data: {
        organizationId: args.organizationId,
        threadId: args.thread.id,
        channel: 'whatsapp',
        direction: 'outbound',
        metaMessageId: metaId,
        toNumber: args.message.from,
        messageType: quickReplies.length > 0 ? 'interactive' : 'text',
        body,
        rawPayload: { sentBy: 'bot', flow: true, quickReplies } as never,
      },
    });
    await tx.whatsAppThread.update({
      where: { id: args.thread.id },
      data: { lastMessageAt: new Date() },
    });
  }).catch((err) => args.log.warn({ err }, '[flow] persist outbound failed'));
}

async function saveState(
  args: { organizationId: string; thread: { id: string }; log: Logger },
  state: FlowState,
): Promise<void> {
  await withTenant(args.organizationId, (tx) =>
    tx.whatsAppThread.update({ where: { id: args.thread.id }, data: { flowState: state as never } }),
  ).catch((err) => args.log.warn({ err }, '[flow] save state failed'));
}

async function markThreadPending(args: {
  organizationId: string;
  thread: { id: string };
}): Promise<void> {
  await withTenant(args.organizationId, (tx) =>
    tx.whatsAppThread.update({ where: { id: args.thread.id }, data: { status: 'pending' } }),
  );
}

// Resolve an Asset id → its Wasabi storage key (voice notes stored as assets).
async function resolveAssetKey(
  args: { organizationId: string },
  assetId: string,
): Promise<string | null> {
  const asset = await withTenant(args.organizationId, (tx) =>
    tx.asset.findFirst({ where: { id: assetId }, select: { storageKey: true } }),
  );
  return asset?.storageKey ?? null;
}

// Voice note: stream the object from storage → upload to Meta /media → send as
// audio. No-op (logged) if storage isn't configured or the object is missing.
async function sendVoiceByKey(
  args: { organizationId: string; channel: FlowChannel; message: FlowInbound; log: Logger },
  storageKey: string,
): Promise<void> {
  const { getObjectStream, isStorageConfigured } = await import('./storage.js');
  if (!isStorageConfigured()) {
    // Silent-fail here used to hide the #1 reason a greeting voice never plays.
    args.log.warn({ storageKey }, '[flow] voice skipped: storage not configured');
    return;
  }
  const stream = await getObjectStream(storageKey);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  const buf = Buffer.concat(chunks);
  // Content type from the key's extension (WhatsApp needs a correct audio mime).
  const ext = (storageKey.split('.').pop() ?? '').toLowerCase();
  const mime =
    ext === 'mp3' ? 'audio/mpeg'
    : ext === 'm4a' ? 'audio/mp4'
    : ext === 'webm' ? 'audio/webm'
    : ext === 'aac' ? 'audio/aac'
    : ext === 'wav' ? 'audio/wav'
    : ext === 'amr' ? 'audio/amr'
    : 'audio/ogg';
  // Upload to Meta /media.
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), `voice.${ext || 'ogg'}`);
  const up = await fetch(`${GRAPH}/${encodeURIComponent(args.channel.phoneNumberId!)}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.channel.accessToken!}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const upBody = await up.text();
  if (!up.ok) {
    args.log.warn({ status: up.status, body: upBody.slice(0, 300), mime, ext }, '[flow] voice media upload failed');
    return;
  }
  const mediaId = (JSON.parse(upBody) as { id?: string }).id;
  if (!mediaId) {
    args.log.warn({ body: upBody.slice(0, 300) }, '[flow] voice media upload returned no id');
    return;
  }
  const sent = await fetch(`${GRAPH}/${encodeURIComponent(args.channel.phoneNumberId!)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.channel.accessToken!}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: args.message.from,
      type: 'audio',
      audio: { id: mediaId },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  // The final send used to be fire-and-forget — a Meta rejection (bad audio
  // format, recipient outside the 24h window) vanished with no trace. Log it so
  // "the greeting voice didn't play" is diagnosable from prod logs.
  if (!sent.ok) {
    const body = await sent.text().catch(() => '');
    args.log.warn({ status: sent.status, body: body.slice(0, 300) }, '[flow] voice audio send failed');
    return;
  }
  args.log.info({ storageKey, mime }, '[flow] greeting voice sent');
}

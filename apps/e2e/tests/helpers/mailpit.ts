import { request } from 'undici';
import { env } from './env';

type MailpitSummary = {
  ID: string;
  From: { Address: string };
  To: { Address: string }[];
  Subject: string;
  Created: string;
};

type MailpitMessage = {
  ID: string;
  From: { Address: string };
  To: { Address: string }[];
  Subject: string;
  Text: string;
  HTML: string;
};

async function mailpitJson<T>(path: string): Promise<T> {
  const { statusCode, body } = await request(`${env.MAILPIT_URL}${path}`);
  if (statusCode >= 400) throw new Error(`Mailpit ${path} → ${statusCode}`);
  return (await body.json()) as T;
}

export async function waitForEmail(opts: {
  to: string;
  subjectIncludes?: string;
  timeoutMs?: number;
}): Promise<MailpitMessage> {
  const timeout = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeout;
  const to = opts.to.toLowerCase();

  while (Date.now() < deadline) {
    const res = await mailpitJson<{ messages: MailpitSummary[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:${opts.to}`)}`,
    );
    for (const m of res.messages ?? []) {
      if (!m.To.some((addr) => addr.Address.toLowerCase() === to)) continue;
      if (opts.subjectIncludes && !m.Subject.includes(opts.subjectIncludes)) continue;
      return await mailpitJson<MailpitMessage>(`/api/v1/message/${m.ID}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No email to ${opts.to} matching ${opts.subjectIncludes ?? '(any)'} within ${timeout}ms`);
}

export function extractFirstUrl(body: string, mustInclude: string): string {
  const re = /https?:\/\/[^\s<>"')]+/g;
  const matches = body.match(re) ?? [];
  const match = matches.find((u) => u.includes(mustInclude));
  if (!match) throw new Error(`No URL containing "${mustInclude}" in message body`);
  return match;
}

export async function clearInbox(): Promise<void> {
  await request(`${env.MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
}

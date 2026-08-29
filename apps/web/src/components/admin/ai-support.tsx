'use client';

// HQ "AI support" copilot — a right slide-over chat for super-admins.
// Streams the answer token-by-token (typewriter) from
// POST /api/v1/hq/support/chat via a fetch ReadableStream.
import { brand } from '@/lib/brand';
import { Bot, Send, Sparkles, Square, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getAccessToken } from '@/lib/api';
import { cn } from '@/lib/utils';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Msg = { role: 'user' | 'assistant'; content: string };

const SUGGESTIONS = [
  'How many active tenants do we have?',
  'Show me a summary of the Booty Republic tenant',
  'Which tenants are on the free plan?',
  'How do broadcasts and quotas work?',
];

interface AiSupportCtx {
  open: () => void;
}
const Ctx = createContext<AiSupportCtx | null>(null);

export function useAiSupport(): AiSupportCtx {
  return useContext(Ctx) ?? { open: () => {} };
}

export function AiSupportProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Ctx.Provider value={{ open: () => setIsOpen(true) }}>
      {children}
      <AiSupportPanel open={isOpen} onClose={() => setIsOpen(false)} />
    </Ctx.Provider>
  );
}

function AiSupportPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mount-then-animate so the panel slides in on open and out on close.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(t);
  }, [open]);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep pinned to the newest message as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || streaming) return;
      const history = [...messages, { role: 'user' as const, content: clean }];
      setMessages([...history, { role: 'assistant', content: '' }]);
      setInput('');
      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(`${API_URL}/api/v1/hq/support/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getAccessToken() ?? ''}`,
          },
          credentials: 'include',
          body: JSON.stringify({ messages: history }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`request failed (${res.status})`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: 'assistant', content: acc };
            return copy;
          });
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              role: 'assistant',
              content: (last?.content || '') + '\n\n_Connection error — please try again._',
            };
            return copy;
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [input, streaming, messages],
  );

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="AI support">
      {/* Backdrop */}
      <div
        className={cn(
          'absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-300',
          shown ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />

      {/* Panel — ~30% of the screen on desktop, full-width on mobile. */}
      <div
        className={cn(
          'absolute right-0 top-0 flex h-full w-full flex-col bg-surface shadow-2xl',
          'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          'sm:w-[34rem] md:w-[32vw] md:min-w-[30rem]',
          shown ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border bg-gradient-to-r from-brand-600 to-brand-500 px-5 py-4 text-white">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/20">
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">{brand.name} Copilot</p>
            <p className="text-[11px] text-white/75">HQ · ask about anything in the platform</p>
          </div>
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={() => setMessages([])}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/15 hover:text-white"
            >
              New chat
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/85 transition hover:bg-white/15 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-5">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-5 px-4 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-500 dark:bg-brand-500/10">
                <Bot className="size-7" />
              </span>
              <div className="space-y-1">
                <p className="text-base font-semibold text-foreground">How can I help?</p>
                <p className="mx-auto max-w-xs text-xs text-foreground-muted">
                  I know the whole platform — tenants, products, quotas, billing, channels, and how
                  every feature works. Ask me anything.
                </p>
              </div>
              <div className="grid w-full max-w-sm gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-xl border border-border bg-surface-muted/40 px-3 py-2.5 text-left text-xs font-medium text-foreground-muted transition hover:border-brand-300 hover:bg-brand-50/40 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => <Bubble key={i} msg={m} streaming={streaming && i === messages.length - 1} />)
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-surface px-4 py-3">
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-muted/30 px-3 py-2 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400/30">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder="Ask anything…"
              className="max-h-32 flex-1 resize-none bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-foreground-subtle"
            />
            {streaming ? (
              <Button size="icon" variant="secondary" className="size-9 shrink-0" onClick={stop} aria-label="Stop">
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-9 shrink-0"
                onClick={() => void send(input)}
                disabled={!input.trim()}
                aria-label="Send"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-[10px] text-foreground-subtle">
            {brand.name} Copilot can make mistakes — double-check important actions.
          </p>
        </div>
      </div>
    </div>
  );
}

function Bubble({ msg, streaming }: { msg: Msg; streaming: boolean }) {
  const isUser = msg.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
          'animate-[fadeIn_180ms_ease-out]',
          isUser
            ? 'rounded-br-md bg-brand-500 text-white'
            : 'rounded-bl-md border border-border bg-surface-muted/40 text-foreground',
        )}
      >
        {msg.content}
        {streaming ? (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-current align-middle opacity-70" />
        ) : null}
        {!isUser && streaming && msg.content === '' ? (
          <span className="text-foreground-subtle">Thinking…</span>
        ) : null}
      </div>
    </div>
  );
}

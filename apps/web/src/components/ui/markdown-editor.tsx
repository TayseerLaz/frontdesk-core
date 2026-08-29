'use client';

import { Bold, Italic, Link as LinkIcon, List, ListOrdered, Heading, Eye, Pencil } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Markdown-backed "rich text" editor. We store and transmit plain markdown
// (chatbot-safe), but give the user a toolbar + preview so the editing
// experience meets the spec's "rich text descriptions" requirement.
// No heavy deps (no Tiptap/ProseMirror); works under React 19 + Next 15.

type MarkdownEditorProps = {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
};

export function MarkdownEditor({
  id,
  value,
  onChange,
  placeholder,
  rows = 8,
  disabled,
  className,
  ...rest
}: MarkdownEditorProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = React.useState<'edit' | 'preview'>('edit');

  // Wraps the current selection with `before` / `after`. If nothing is
  // selected, inserts a placeholder so the user sees the formatting at once.
  const wrapSelection = (before: string, after: string, placeholderText = 'text') => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end) || placeholderText;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    // Re-focus + re-select the inserted text after React re-renders.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  // Prefixes each selected line with `prefix`. Used for lists + headings.
  const prefixLines = (prefix: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = value.lastIndexOf('\n', Math.max(start - 1, 0)) + 1;
    const selected = value.slice(lineStart, end) || 'List item';
    const replaced = selected
      .split('\n')
      .map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`))
      .join('\n');
    const next = value.slice(0, lineStart) + replaced + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(lineStart, lineStart + replaced.length);
    });
  };

  const insertLink = () => {
    const url = window.prompt('Link URL', 'https://');
    if (!url) return;
    wrapSelection('[', `](${url})`, 'link text');
  };

  const toolButtonClass =
    'inline-flex size-8 items-center justify-center rounded-md text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40';

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border bg-surface shadow-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-400',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-1 border-b border-border bg-surface-muted/40 px-1.5 py-1">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => wrapSelection('**', '**', 'bold')}
            className={toolButtonClass}
            aria-label="Bold"
            title="Bold (Ctrl+B)"
            disabled={disabled || mode === 'preview'}
          >
            <Bold className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => wrapSelection('*', '*', 'italic')}
            className={toolButtonClass}
            aria-label="Italic"
            title="Italic (Ctrl+I)"
            disabled={disabled || mode === 'preview'}
          >
            <Italic className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => prefixLines('## ')}
            className={toolButtonClass}
            aria-label="Heading"
            title="Heading"
            disabled={disabled || mode === 'preview'}
          >
            <Heading className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => prefixLines('- ')}
            className={toolButtonClass}
            aria-label="Bulleted list"
            title="Bulleted list"
            disabled={disabled || mode === 'preview'}
          >
            <List className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => prefixLines('1. ')}
            className={toolButtonClass}
            aria-label="Numbered list"
            title="Numbered list"
            disabled={disabled || mode === 'preview'}
          >
            <ListOrdered className="size-4" />
          </button>
          <button
            type="button"
            onClick={insertLink}
            className={toolButtonClass}
            aria-label="Insert link"
            title="Insert link"
            disabled={disabled || mode === 'preview'}
          >
            <LinkIcon className="size-4" />
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setMode('edit')}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
              mode === 'edit' ? 'bg-surface text-foreground shadow-sm' : 'text-foreground hover:bg-surface-muted',
            )}
            aria-pressed={mode === 'edit'}
            aria-label="Edit mode"
          >
            <Pencil className="size-3.5" /> Edit
          </button>
          <button
            type="button"
            onClick={() => setMode('preview')}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
              mode === 'preview' ? 'bg-surface text-foreground shadow-sm' : 'text-foreground hover:bg-surface-muted',
            )}
            aria-pressed={mode === 'preview'}
            aria-label="Preview mode"
          >
            <Eye className="size-3.5" /> Preview
          </button>
        </div>
      </div>
      {mode === 'edit' ? (
        <textarea
          id={id}
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
              e.preventDefault();
              wrapSelection('**', '**', 'bold');
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
              e.preventDefault();
              wrapSelection('*', '*', 'italic');
            }
          }}
          className="block w-full resize-y border-0 bg-surface px-3 py-2 font-mono text-sm leading-6 focus:outline-none focus:ring-0"
          aria-label={rest['aria-label']}
        />
      ) : (
        <div
          className="prose-aligned max-h-[480px] overflow-auto px-3 py-2 text-sm"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderMarkdown(value || '_Nothing to preview._') }}
        />
      )}
    </div>
  );
}

// Minimal block-level markdown renderer. Covers the formatting the toolbar
// produces: headings, bold, italic, links, bulleted + numbered lists,
// paragraphs. Everything else is rendered as plain text (HTML-escaped).
// Deliberately small and regex-based — the rendered output never leaves the
// browser (we store raw markdown on the server).
export function renderMarkdown(input: string): string {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const inline = (text: string) =>
    escapeHtml(text)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
        const safe = /^https?:\/\//i.test(url) ? url : '#';
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="text-brand-500 underline">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code class="rounded bg-surface-muted px-1 py-0.5 text-xs">$1</code>');

  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      closeLists();
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      closeLists();
      const level = headingMatch[1]?.length ?? 2;
      out.push(`<h${level} class="mt-2 font-semibold">${inline(headingMatch[2] ?? '')}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul class="list-disc pl-5 space-y-1">');
        inUl = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol class="list-decimal pl-5 space-y-1">');
        inOl = true;
      }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }
    closeLists();
    paragraph.push(line);
  }
  flushParagraph();
  closeLists();
  return out.join('\n');
}

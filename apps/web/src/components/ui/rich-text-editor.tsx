'use client';

import Link from '@tiptap/extension-link';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, Heading2, Link as LinkIcon, List, ListOrdered, Pilcrow, Quote, Strikethrough, Undo, Redo } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Tiptap-based rich-text editor — returns/accepts HTML strings.
// Supersedes the old markdown-only editor. Storage format on the server
// stays as plain text (the same column); the chatbot read API strips
// HTML via stripHtmlForBot so bot replies stay clean.
//
// Existing rows that were authored in the old markdown editor render as
// literal text (no auto-conversion). Customers can re-edit to apply
// formatting; that's a one-time cost for the upgrade.

type RichTextEditorProps = {
  id?: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  rows?: number;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
};

const toolbarBtn =
  'inline-flex size-8 items-center justify-center rounded-md text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 disabled:opacity-40';
const toolbarBtnActive = 'bg-surface-muted ring-1 ring-inset ring-brand-300';

export function RichTextEditor({
  id,
  value,
  onChange,
  placeholder,
  rows = 8,
  disabled,
  className,
  ...rest
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
    ],
    content: value || '',
    editable: !disabled,
    immediatelyRender: false, // SSR-safe in Next.js App Router
    editorProps: {
      attributes: {
        id: id ?? 'rich-text',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': rest['aria-label'] ?? 'Rich text editor',
        class:
          'prose prose-sm max-w-none px-3 py-2 focus:outline-none [&_p]:my-1 [&_h2]:mt-2 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_a]:text-brand-500 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-foreground-muted',
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Tiptap returns "<p></p>" for empty — normalise to '' so empty
      // checks downstream don't see a phantom value.
      onChange(html === '<p></p>' ? '' : html);
    },
  });

  // Sync incoming value changes into the editor (e.g. when a parent
  // re-fetches and resets state).
  React.useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const incoming = value || '';
    if (incoming && incoming !== current) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [editor, value]);

  if (!editor) {
    // Render a static fallback during SSR — same height as the editor so
    // there's no layout shift.
    return (
      <div
        className={cn(
          'overflow-hidden rounded-md border border-border bg-surface shadow-sm',
          className,
        )}
      >
        <div className="border-b border-border bg-surface-muted/40 px-1.5 py-1" style={{ height: 36 }} />
        <div className="px-3 py-2" style={{ minHeight: rows * 24 }} />
      </div>
    );
  }

  const insertLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previous ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: url }).run();
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border bg-surface shadow-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-400',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-surface-muted/40 px-1.5 py-1">
        <ToolButton
          aria-label="Bold"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Italic"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Strikethrough"
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="size-4" />
        </ToolButton>
        <span className="mx-1 inline-block h-5 w-px bg-border" />
        <ToolButton
          aria-label="Heading 2"
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Paragraph"
          active={editor.isActive('paragraph')}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >
          <Pilcrow className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Bulleted list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Numbered list"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Block quote"
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="size-4" />
        </ToolButton>
        <span className="mx-1 inline-block h-5 w-px bg-border" />
        <ToolButton
          aria-label="Insert link"
          active={editor.isActive('link')}
          onClick={insertLink}
        >
          <LinkIcon className="size-4" />
        </ToolButton>
        <span className="mx-1 inline-block h-5 w-px bg-border" />
        <ToolButton
          aria-label="Undo"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
        >
          <Undo className="size-4" />
        </ToolButton>
        <ToolButton
          aria-label="Redo"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
        >
          <Redo className="size-4" />
        </ToolButton>
      </div>
      <div style={{ minHeight: rows * 24 }}>
        <EditorContent editor={editor} placeholder={placeholder} />
      </div>
    </div>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  children,
  ...rest
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  'aria-label': string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(toolbarBtn, active && toolbarBtnActive)}
      {...rest}
    >
      {children}
    </button>
  );
}

// Backwards-compat re-export so existing imports keep working without a
// pile of search-and-replace. Old callers used <MarkdownEditor> with a
// `value` that was markdown text; the new editor accepts the same string
// (rendered as plain text if not HTML) and emits HTML on change.
export { RichTextEditor as MarkdownEditor };

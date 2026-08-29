'use client';

// Code-split boundary for the Tiptap rich-text editor. The editor + its
// ProseMirror/Tiptap dependency graph is heavy (~tens of kB) and only ever
// renders on the catalog/business-info edit pages — and only client-side.
// Loading it via next/dynamic keeps it out of those routes' initial JS so the
// page paints (and the rest of the form is interactive) before the editor
// chunk arrives. Same `MarkdownEditor` name + props as before — drop-in.
import dynamic from 'next/dynamic';

import { Skeleton } from './skeleton';

export const MarkdownEditor = dynamic(
  () => import('./rich-text-editor').then((m) => m.RichTextEditor),
  {
    ssr: false,
    loading: () => <Skeleton className="h-40 w-full rounded-md" />,
  },
);

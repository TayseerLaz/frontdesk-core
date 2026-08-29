'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ExternalLink, Square } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Step {
  key: string;
  title: string;
  description: string;
  completedAt: string | null;
  notes: string | null;
}

export default function MetaOnboardingPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['meta-onboarding'],
    queryFn: () => api.get<{ data: Step[] }>('/api/v1/onboarding/meta'),
  });

  const toggle = useMutation({
    mutationFn: ({ key, done }: { key: string; done: boolean }) =>
      api.post(`/api/v1/onboarding/meta/${encodeURIComponent(key)}`, { done }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['meta-onboarding'] }),
    onError: () => toast.error('Failed to update'),
  });

  const steps = q.data?.data ?? [];
  const done = steps.filter((s) => s.completedAt).length;

  return (
    <>
      <PageHeader
        title="Meta business verification"
        description="Walk through the 7-step Meta workflow to verify your WhatsApp Business Account. Mark each step done as you complete it."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/whatsapp">
              <ArrowLeft className="size-4" /> Back to WhatsApp
            </Link>
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex items-center justify-between py-3">
          <p className="text-sm">
            Progress: <strong>{done}</strong> of <strong>{steps.length}</strong> steps
          </p>
          <div
            className="h-2 w-48 overflow-hidden rounded-full bg-surface-muted"
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={steps.length}
          >
            <div
              className="h-full bg-brand-500 transition-[width]"
              style={{ width: `${(done / Math.max(1, steps.length)) * 100}%` }}
            />
          </div>
        </CardContent>
      </Card>

      <ol className="space-y-3">
        {steps.map((s, i) => {
          const isDone = !!s.completedAt;
          return (
            <li key={s.key}>
              <Card className={cn(isDone && 'border-emerald-200 bg-emerald-50/30')}>
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                        isDone ? 'bg-emerald-500 text-white' : 'bg-brand-50 text-brand-600',
                      )}
                    >
                      {isDone ? <CheckCircle2 className="size-4" /> : i + 1}
                    </span>
                    <div>
                      <CardTitle className="text-base">{s.title}</CardTitle>
                      <CardDescription className="mt-1">{s.description}</CardDescription>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={isDone ? 'secondary' : 'primary'}
                    loading={toggle.isPending && toggle.variables?.key === s.key}
                    onClick={() => toggle.mutate({ key: s.key, done: !isDone })}
                  >
                    {isDone ? (
                      <>
                        <Square className="size-3.5" /> Mark not done
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="size-3.5" /> Mark done
                      </>
                    )}
                  </Button>
                </CardHeader>
                {i === 0 ? (
                  <CardContent>
                    <Button variant="link" size="sm" asChild>
                      <a href="https://business.facebook.com" target="_blank" rel="noreferrer noopener">
                        Open Meta Business <ExternalLink className="size-3" />
                      </a>
                    </Button>
                  </CardContent>
                ) : null}
                {i === 1 ? (
                  <CardContent>
                    <Button variant="link" size="sm" asChild>
                      <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer noopener">
                        Open Meta for Developers <ExternalLink className="size-3" />
                      </a>
                    </Button>
                  </CardContent>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// Phase 2 — branding (logo / accent / footer / custom CNAME) is hidden
// until those fields are wired into the actual portal layout. The full
// implementation is preserved in git history at commit 568f9df and
// earlier; re-enable by reverting this file.
import Link from 'next/link';
import { ArrowLeft, Palette } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function BrandingPage() {
  return (
    <>
      <PageHeader
        title="Branding"
        description="Coming in a future release."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/settings">
              <ArrowLeft className="size-4" /> Back to settings
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="size-4" /> Branding is coming soon
          </CardTitle>
          <CardDescription>
            White-label features — logo upload, accent colour, footer text, and custom-CNAME on
            your own domain — are part of a later release. We&apos;ll surface this page once they
            actually change what your team sees.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-foreground-muted">
          For now, the platform uses its default styling. If you need an early demo of
          white-labelling for a customer pitch, ping support.
        </CardContent>
      </Card>
    </>
  );
}

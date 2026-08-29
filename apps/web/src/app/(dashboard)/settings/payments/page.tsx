'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';

interface PaymentConfig {
  provider: string;
  staticLinkUrl: string | null;
  bankDetails: string | null;
  testMode: boolean;
  hasMyfatoorahKey: boolean;
  hasStripeKey: boolean;
  hasPaypalCreds: boolean;
  ready: boolean;
  updatedAt: string;
}

const PROVIDERS: { value: string; label: string; blurb: string }[] = [
  { value: 'none', label: 'No online payment', blurb: 'The bot won’t send a payment link.' },
  { value: 'cash', label: 'Cash / pay on delivery', blurb: 'Customer pays in cash. No link needed.' },
  { value: 'bank_transfer', label: 'Bank transfer', blurb: 'Bot sends your bank details as instructions.' },
  { value: 'static_link', label: 'Static payment link', blurb: 'Your own hosted/Whish/OMT link, reused for every order.' },
  { value: 'myfatoorah', label: 'MyFatoorah', blurb: 'Gulf — KNET + cards. Per-order invoice link.' },
  { value: 'stripe', label: 'Stripe', blurb: 'Global cards. Per-order Checkout link.' },
  { value: 'paypal', label: 'PayPal', blurb: 'Per-order PayPal order link (PayPal-supported currencies).' },
];

export default function PaymentsSettingsPage() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['payment-config'],
    queryFn: () => api.get<{ data: PaymentConfig }>('/api/v1/payment-config'),
  });

  const [provider, setProvider] = useState('none');
  const [staticLinkUrl, setStaticLinkUrl] = useState('');
  const [bankDetails, setBankDetails] = useState('');
  const [testMode, setTestMode] = useState(true);
  // Credential inputs are blank on load (never returned); typing sets them.
  const [myfatoorahApiKey, setMyfatoorahApiKey] = useState('');
  const [stripeSecretKey, setStripeSecretKey] = useState('');
  const [paypalClientId, setPaypalClientId] = useState('');
  const [paypalSecret, setPaypalSecret] = useState('');
  const cfg = q.data?.data;

  useEffect(() => {
    if (!cfg) return;
    setProvider(cfg.provider);
    setStaticLinkUrl(cfg.staticLinkUrl ?? '');
    setBankDetails(cfg.bankDetails ?? '');
    setTestMode(cfg.testMode);
  }, [cfg]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/payment-config', {
        provider,
        staticLinkUrl: staticLinkUrl.trim() || null,
        bankDetails: bankDetails.trim() || null,
        testMode,
        // Only send credential fields the operator actually typed (blank =
        // leave unchanged). The API treats '' as "clear".
        ...(myfatoorahApiKey ? { myfatoorahApiKey } : {}),
        ...(stripeSecretKey ? { stripeSecretKey } : {}),
        ...(paypalClientId ? { paypalClientId } : {}),
        ...(paypalSecret ? { paypalSecret } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-config'] });
      setMyfatoorahApiKey('');
      setStripeSecretKey('');
      setPaypalClientId('');
      setPaypalSecret('');
      toast.success('Payment settings saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const Saved = () => (
    <Badge variant="success" className="ml-2">
      <CheckCircle2 className="mr-1 size-3" /> saved
    </Badge>
  );

  return (
    <>
      <PageHeader title="Payments" description="How customers pay when they order through the bot." />
      <Link
        href="/settings"
        className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to settings
      </Link>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="size-4" /> Payment provider
            {cfg?.ready && provider !== 'none' ? (
              <Badge variant="success">ready</Badge>
            ) : provider !== 'none' && provider !== 'cash' ? (
              <Badge variant="muted">needs setup</Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Pick one. The bot uses it to send a real payment link (or instructions) when the customer
            checks out. Credentials are encrypted and never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label>Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-foreground-muted">
              {PROVIDERS.find((p) => p.value === provider)?.blurb}
            </p>
          </div>

          {provider === 'static_link' && (
            <div>
              <Label htmlFor="pay-static">Payment link</Label>
              <Input
                id="pay-static"
                value={staticLinkUrl}
                onChange={(e) => setStaticLinkUrl(e.target.value)}
                placeholder="https://wish.money/... or your hosted checkout page"
              />
            </div>
          )}

          {provider === 'bank_transfer' && (
            <div>
              <Label htmlFor="pay-bank">Bank transfer instructions</Label>
              <Textarea
                id="pay-bank"
                rows={4}
                value={bankDetails}
                onChange={(e) => setBankDetails(e.target.value)}
                placeholder={'Bank: …\nIBAN: …\nAccount name: …\nSend the receipt here after transferring.'}
              />
            </div>
          )}

          {provider === 'myfatoorah' && (
            <div>
              <Label htmlFor="pay-mf">
                MyFatoorah API key {cfg?.hasMyfatoorahKey && <Saved />}
              </Label>
              <Input
                id="pay-mf"
                type="password"
                value={myfatoorahApiKey}
                onChange={(e) => setMyfatoorahApiKey(e.target.value)}
                placeholder={cfg?.hasMyfatoorahKey ? '•••••••• (leave blank to keep)' : 'Paste your MyFatoorah API token'}
              />
            </div>
          )}

          {provider === 'stripe' && (
            <div>
              <Label htmlFor="pay-stripe">
                Stripe secret key {cfg?.hasStripeKey && <Saved />}
              </Label>
              <Input
                id="pay-stripe"
                type="password"
                value={stripeSecretKey}
                onChange={(e) => setStripeSecretKey(e.target.value)}
                placeholder={cfg?.hasStripeKey ? '•••••••• (leave blank to keep)' : 'sk_live_… or sk_test_…'}
              />
            </div>
          )}

          {provider === 'paypal' && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="pay-pp-id">
                  PayPal client ID {cfg?.hasPaypalCreds && <Saved />}
                </Label>
                <Input
                  id="pay-pp-id"
                  value={paypalClientId}
                  onChange={(e) => setPaypalClientId(e.target.value)}
                  placeholder={cfg?.hasPaypalCreds ? '•••••••• (leave blank to keep)' : 'PayPal app client ID'}
                />
              </div>
              <div>
                <Label htmlFor="pay-pp-secret">PayPal secret</Label>
                <Input
                  id="pay-pp-secret"
                  type="password"
                  value={paypalSecret}
                  onChange={(e) => setPaypalSecret(e.target.value)}
                  placeholder={cfg?.hasPaypalCreds ? '•••••••• (leave blank to keep)' : 'PayPal app secret'}
                />
              </div>
            </div>
          )}

          {(provider === 'myfatoorah' || provider === 'stripe' || provider === 'paypal') && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-border accent-brand-500"
                checked={testMode}
                onChange={(e) => setTestMode(e.target.checked)}
              />
              Test / sandbox mode (use test credentials)
            </label>
          )}

          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save payment settings
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

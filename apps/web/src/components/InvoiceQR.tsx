import { CheckCircle2, Copy, Loader2, Wallet, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import { encode } from 'uqr';
import { useI18n } from '../i18n';
import { useToast } from './Toast';
import type { DemoPay } from '../lib/api';
import { Badge, Button, ICON } from './ui';

const QUIET = 4;

/** One SVG path for all dark modules (uppercase BOLT11 fits QR alphanumeric mode). */
function qrPath(text: string): { d: string; size: number } {
  const qr = encode(text.toUpperCase(), { ecc: 'M', border: 0 });
  let d = '';
  qr.data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }),
  );
  return { d, size: qr.size + QUIET * 2 };
}

export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'failed';

/** QR + copy + open-in-wallet + live "payé" state (docs/BRIEF.md §10.3). */
export function InvoiceQR({
  invoice,
  status,
  amount,
  demoPay = null,
  onDemoPay,
  paying,
}: {
  invoice: string;
  status: InvoiceStatus;
  amount: string;
  /** The demo "pay" button: simulate (FakeWallet) or test (test payer wallet). */
  demoPay?: DemoPay;
  onDemoPay?: () => void;
  paying?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { d, size } = useMemo(() => qrPath(`lightning:${invoice}`), [invoice]);
  const paid = status === 'paid';

  return (
    <div className="rounded-card border border-line bg-surface p-4 sm:p-6">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <div className="relative shrink-0">
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className={`h-56 w-56 rounded-lg bg-white transition-opacity ${paid ? 'opacity-20' : ''}`}
            shapeRendering="crispEdges"
            role="img"
            aria-label={t.sponsor.scan}
          >
            <path d={d} fill="#0B1F33" />
          </svg>
          {paid && (
            <span className="absolute inset-0 flex items-center justify-center text-calm">
              <CheckCircle2 size={72} strokeWidth={1.5} aria-hidden />
            </span>
          )}
        </div>
        <div className="flex w-full min-w-0 flex-col gap-3">
          <p className="tabular text-title font-semibold text-ink">{amount}</p>
          <p
            aria-live="polite"
            role="status"
            data-testid="invoice-status"
            data-status={status}
            className={`flex items-center gap-2 font-medium ${
              paid ? 'text-calm' : status === 'pending' ? 'text-muted' : 'text-danger'
            }`}
          >
            {paid ? (
              <CheckCircle2 {...ICON} />
            ) : status === 'pending' ? (
              <Loader2 {...ICON} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <XCircle {...ICON} />
            )}
            {paid ? t.sponsor.paid : status === 'pending' ? t.sponsor.waiting : t.sponsor.expired}
          </p>
          {!paid && status === 'pending' && (
            <>
              <p className="text-sm text-muted">
                {demoPay === 'test' ? t.sponsor.scanTest : t.sponsor.scan}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <a
                  href={`lightning:${invoice}`}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-btn bg-ocean px-4 font-medium text-white hover:bg-[#094d78]"
                >
                  <Wallet {...ICON} />
                  {t.sponsor.openWallet}
                </a>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void navigator.clipboard?.writeText(invoice).then(
                      () => toast(t.common.copied),
                      () => {},
                    )
                  }
                >
                  <Copy {...ICON} />
                  {t.sponsor.copyInvoice}
                </Button>
              </div>
              <p className="font-mono text-[12px] break-all text-muted select-all">{invoice}</p>
            </>
          )}
          {demoPay && status === 'pending' && onDemoPay && (
            <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-line pt-3">
              <Badge kind={demoPay === 'test' ? 'test' : 'simulated'} />
              <Button
                variant="secondary"
                onClick={onDemoPay}
                disabled={paying}
                data-testid="demo-pay"
              >
                {paying && demoPay === 'test' ? (
                  <Loader2 {...ICON} className="animate-spin motion-reduce:animate-none" />
                ) : null}
                {demoPay === 'test' ? t.sponsor.testPay : t.sponsor.simulate}
              </Button>
              <span className="text-sm text-muted">
                {demoPay === 'test' ? t.sponsor.testPayHint : t.sponsor.simulateHint}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

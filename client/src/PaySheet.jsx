import { useEffect, useMemo, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, ExpressCheckoutElement, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { payStart, dollars } from './lib';

// Pay a tutor inside the room: a tip, or the lesson price at the door.
// The card form is Stripe's, rendered inside this sheet; the charge goes
// straight to the tutor's own Stripe account. Cove never sees the card.
// Apple Pay / Google Pay / Link appear as one-tap buttons when the device has them.

const PRESETS = [200, 500, 1000];
const stripes = {};
const stripeFor = (pk, account) => (stripes[account] ||= loadStripe(pk, { stripeAccount: account }));

export default function PaySheet({ slug, token, kind, to, onPaid, onClose, onToast }) {
  const [amount, setAmount] = useState(kind === 'lesson' ? null : 500);
  const [other, setOther] = useState('');
  const [intent, setIntent] = useState(null);   // { clientSecret, intentId, account, publishableKey, amount }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = kind === 'lesson' ? 0 : other ? Math.round(Number(other) * 100) : amount;

  const start = async () => {
    setBusy(true); setErr('');
    try { setIntent(await payStart(token, slug, kind, chosen)); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  useEffect(() => { if (kind === 'lesson') start(); }, []);

  const options = useMemo(() => intent && {
    clientSecret: intent.clientSecret,
    appearance: { theme: 'night', variables: { colorPrimary: '#FFB454', colorBackground: '#132026', colorText: '#E8EFF0', borderRadius: '10px', fontFamily: 'Inter, sans-serif' } }
  }, [intent]);

  return (
    <div className="ph-scrim" onClick={onClose}>
      <div className="ph-sheet desk pay" role="dialog" aria-label={kind === 'lesson' ? 'Pay for the lesson' : `Tip ${to}`} onClick={(e) => e.stopPropagation()}>
        <h3>{kind === 'lesson' ? `Pay ${to} for the lesson` : `Tip ${to}`}</h3>
        {!intent && kind === 'tip' && (
          <>
            <div className="tip-presets">
              {PRESETS.map((c) => <button key={c} className={amount === c && !other ? 'on' : ''} onClick={() => { setAmount(c); setOther(''); }}>{dollars(c)}</button>)}
              <label className={other ? 'on' : ''}>$<input inputMode="decimal" placeholder="other" value={other} maxLength={6} onChange={(e) => setOther(e.target.value.replace(/[^\d.]/g, ''))} /></label>
            </div>
            <p className="pay-fine">Goes to {to}'s own account; Cove takes nothing. Paying confirms you're an adult paying for yourself or your child.</p>
            {err && <p className="wall-err">{err}</p>}
            <div className="wall-compose-btns">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !(chosen >= 100 && chosen <= 20000)} onClick={start}>{busy ? '…' : `Tip ${chosen >= 100 ? dollars(chosen) : ''}`}</button>
            </div>
          </>
        )}
        {!intent && kind === 'lesson' && <p className="pay-fine">{err || 'One moment…'}</p>}
        {intent && (
          <Elements stripe={stripeFor(intent.publishableKey, intent.account)} options={options}>
            <PayForm amount={intent.amount} kind={kind} to={to} onPaid={() => onPaid(intent.intentId, intent.amount)} onClose={onClose} onToast={onToast} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function PayForm({ amount, kind, to, onPaid, onClose, onToast }) {
  const stripe = useStripe(); const elements = useElements();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [express, setExpress] = useState(false);  // the device offered Apple/Google Pay or Link
  const done = useRef(false);
  const finish = (pi) => { if (done.current) return; done.current = true; onToast?.(kind === 'lesson' ? `Paid ${dollars(amount)} to ${to}` : `Thanks — ${dollars(amount)} to ${to}`); onPaid(pi); };
  const confirm = async (e) => {
    e?.preventDefault?.(); if (!stripe || !elements) return;
    setBusy(true); setErr('');
    const { error, paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: location.href } });
    if (error) { setErr(error.message || 'The payment did not go through.'); setBusy(false); return; }
    if (paymentIntent?.status === 'succeeded' || paymentIntent?.status === 'processing') finish(paymentIntent);
    else { setErr('The payment is still pending. If it goes through you will see it in a moment.'); setBusy(false); }
  };
  return (
    <form className="pay-form" onSubmit={confirm}>
      <div className="pay-amt">{dollars(amount)}<small>{kind === 'lesson' ? ' · lesson' : ' · tip'}</small></div>
      <ExpressCheckoutElement onReady={({ availablePaymentMethods }) => setExpress(!!availablePaymentMethods)} onConfirm={() => confirm()} options={{ buttonHeight: 44, layout: { maxColumns: 1, overflow: 'never' } }} />
      {express && <div className="pay-or">or pay with a card</div>}
      <PaymentElement options={{ layout: 'tabs' }} />
      <p className="pay-fine">Processed by Stripe for {to}. Cove never sees your card. Paying confirms you're an adult paying for yourself or your child.</p>
      {err && <p className="wall-err">{err}</p>}
      <div className="wall-compose-btns">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!stripe || busy}>{busy ? 'Paying…' : `Pay ${dollars(amount)}`}</button>
      </div>
    </form>
  );
}

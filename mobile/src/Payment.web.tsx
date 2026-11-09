import { useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import type { PaymentSession } from '@clubby/contracts';
function Form({ orderId, onResult }: { orderId: string; onResult: () => void }) {
  const stripe = useStripe(),
    elements = useElements();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true);
        setMessage('');
        try {
          const result = await stripe.confirmPayment({
            elements,
            confirmParams: {
              return_url: `${window.location.origin}/?booking=${encodeURIComponent(orderId)}`,
            },
            redirect: 'if_required',
          });
          setMessage(result.error?.message ?? 'Payment submitted. Checking your booking…');
          onResult();
        } catch {
          setMessage('Payment status is uncertain. Check your booking before retrying.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <PaymentElement />
      <button
        type="submit"
        disabled={!stripe || busy}
        style={{ background: '#cdff80', padding: 16, border: 0, borderRadius: 10, marginTop: 16 }}
      >
        {busy ? 'Please wait…' : 'Pay securely'}
      </button>
      {message ? (
        <p role="alert" style={{ color: '#e1e5dc' }}>
          {message}
        </p>
      ) : null}
    </form>
  );
}
export default function Payment({ payment, onResult }: { payment: PaymentSession; onResult: () => void }) {
  const stripe = useMemo(
    () =>
      payment.publishableKey && payment.accountId
        ? loadStripe(payment.publishableKey, { stripeAccount: payment.accountId })
        : null,
    [payment.publishableKey, payment.accountId],
  );
  if (!stripe || !payment.clientSecret) return null;
  return (
    <Elements
      key={`${payment.accountId}:${payment.paymentIntentId}`}
      stripe={stripe}
      options={{
        clientSecret: payment.clientSecret,
        customerSessionClientSecret: payment.customerSessionClientSecret,
        appearance: { theme: 'night' },
      }}
    >
      <Form orderId={payment.orderId} onResult={onResult} />
    </Elements>
  );
}

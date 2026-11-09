import { useEffect, useState } from 'react';
import { Pressable, Text, View, Linking } from 'react-native';
import {
  initStripe,
  initPaymentSheet,
  presentPaymentSheet,
  handleURLCallback,
} from '@stripe/stripe-react-native';
import type { PaymentSession } from '@clubby/contracts';
export default function Payment({ payment, onResult }: { payment: PaymentSession; onResult: () => void }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => {
    const subscription = Linking.addEventListener('url', (event) => {
      void handleURLCallback(event.url);
    });
    void Linking.getInitialURL().then((url) => {
      if (url) void handleURLCallback(url);
    });
    return () => subscription.remove();
  }, []);
  async function pay() {
    if (!payment.clientSecret || !payment.publishableKey || !payment.accountId) return;
    setBusy(true);
    setMessage('');
    try {
      await initStripe({
        publishableKey: payment.publishableKey,
        stripeAccountId: payment.accountId,
        urlScheme: 'clubby',
        ...(process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID
          ? { merchantIdentifier: process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID }
          : {}),
      });
      const initialized = await initPaymentSheet({
        merchantDisplayName: 'Clubby',
        paymentIntentClientSecret: payment.clientSecret,
        returnURL: `clubby://payment-return?booking=${encodeURIComponent(payment.orderId)}`,
        allowsDelayedPaymentMethods: false,
        ...(payment.customerId && payment.customerSessionClientSecret
          ? {
              customerId: payment.customerId,
              customerSessionClientSecret: payment.customerSessionClientSecret,
            }
          : {}),
        ...(process.env.EXPO_PUBLIC_APPLE_MERCHANT_ID ? { applePay: { merchantCountryCode: 'IT' } } : {}),
      });
      if (initialized.error) {
        setMessage(initialized.error.message);
        return;
      }
      const result = await presentPaymentSheet();
      setMessage(
        result.error
          ? result.error.code === 'Canceled'
            ? 'Payment was cancelled. Your booking remains available until the hold expires.'
            : result.error.message
          : 'Payment submitted. Checking your booking…',
      );
      onResult();
    } catch {
      setMessage(
        'Payment could not be completed. Reopen the booking to check its status before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void pay()}
        style={{ backgroundColor: '#cdff80', padding: 16, borderRadius: 10 }}
      >
        <Text>{busy ? 'Please wait…' : 'Open secure payment'}</Text>
      </Pressable>
      {message ? (
        <Text accessibilityRole="alert" style={{ color: '#e1e5dc' }}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

import { useEffect, useState } from 'react';
import { View, Text, Pressable, Linking, Platform } from 'react-native';
import { z } from 'zod';
import { api } from './session';
export default function WalletButtons({ ticketId }: { ticketId: string }) {
  const [cap, setCap] = useState({ apple: false, google: false }),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState<{ wallet: string; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    setLink(null);
    void api
      .request('/v1/wallet/capabilities')
      .then((v) => {
        if (active)
          setCap(z.object({ data: z.object({ apple: z.boolean(), google: z.boolean() }) }).parse(v).data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [ticketId]);
  async function prepare(wallet: 'apple' | 'google') {
    setBusy(true);
    setLink(null);
    setMessage('');
    try {
      const result = z
        .object({ data: z.object({ url: z.string().url() }) })
        .parse(await api.post(`/v1/tickets/${ticketId}/wallet`, { wallet }));
      setLink({ wallet, url: result.data.url });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Wallet pass could not be prepared.');
    } finally {
      setBusy(false);
    }
  }
  if (!cap.apple && !cap.google) return null;
  return (
    <View style={{ gap: 12 }}>
      {cap.apple ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void prepare('apple')}>
          <Text style={{ color: '#cdff80' }}>Add to Apple Wallet</Text>
        </Pressable>
      ) : null}
      {cap.google && Platform.OS === 'web' ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void prepare('google')}>
          <Text style={{ color: '#cdff80' }}>Add to Google Wallet</Text>
        </Pressable>
      ) : null}
      {link ? (
        <Pressable
          accessibilityRole="link"
          onPress={() =>
            void Linking.openURL(link.url).catch(() =>
              setMessage('The wallet link could not be opened. Prepare a new pass and try again.'),
            )
          }
        >
          <Text style={{ color: '#e1e5dc' }}>Open {link.wallet === 'apple' ? 'Apple' : 'Google'} Wallet</Text>
        </Pressable>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={{ color: '#e1e5dc' }}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

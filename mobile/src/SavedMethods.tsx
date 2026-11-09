import { useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { z } from 'zod';
import { api } from './session';
const accountsSchema = z.object({
  data: z.array(z.object({ id: z.string(), sellerName: z.string(), status: z.string() })),
});
const methodsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      brand: z.string(),
      last4: z.string(),
      expMonth: z.number(),
      expYear: z.number(),
    }),
  ),
  meta: z.object({ nextCursor: z.string().nullable() }),
});
export default function SavedMethods() {
  const [accounts, setAccounts] = useState<z.infer<typeof accountsSchema>['data']>([]),
    [selected, setSelected] = useState<string | null>(null),
    [methods, setMethods] = useState<z.infer<typeof methodsSchema>['data']>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setAccounts(accountsSchema.parse(await api.request('/v1/me/payment-accounts')).data);
  }
  async function load(id: string, after?: string) {
    setSelected(id);
    const response = methodsSchema.parse(
      await api.request(`/v1/me/payment-accounts/${id}/methods${after ? `?after=${after}` : ''}`),
    );
    setMethods((previous) => (after ? [...previous, ...response.data] : response.data));
    setCursor(response.meta.nextCursor);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Payment methods could not be loaded.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(refresh);
  }, []);
  return (
    <View style={{ padding: 16, gap: 12, borderColor: '#394236', borderWidth: 1, borderRadius: 12 }}>
      <Text style={{ fontSize: 22, color: '#f7f6ef' }}>Saved payment methods</Text>
      <Text style={{ color: '#e1e5dc' }}>
        Cards are saved separately with each seller. Card details stay with Stripe.
      </Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(refresh)}>
        <Text style={{ color: '#cdff80' }}>Refresh sellers</Text>
      </Pressable>
      {accounts.map((a) => (
        <Pressable
          accessibilityRole="button"
          key={a.id}
          disabled={busy || a.status !== 'ready'}
          onPress={() => void act(() => load(a.id))}
        >
          <Text style={{ color: '#e1e5dc' }}>
            {a.sellerName} · {a.status === 'ready' ? 'View cards' : a.status}
          </Text>
        </Pressable>
      ))}
      {selected ? (
        methods.length ? (
          methods.map((m) => (
            <View key={m.id} style={{ gap: 8 }}>
              <Text style={{ color: '#e1e5dc' }}>
                {m.brand} ending {m.last4} · {m.expMonth}/{m.expYear}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() =>
                  void act(async () => {
                    await api.post(`/v1/me/payment-accounts/${selected}/methods/remove`, { methodId: m.id });
                    await load(selected);
                  })
                }
              >
                <Text style={{ color: '#cdff80' }}>Remove card ending {m.last4}</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={{ color: '#e1e5dc' }}>No saved cards with this seller.</Text>
        )
      ) : null}
      {selected && cursor ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void act(() => load(selected, cursor))}
        >
          <Text style={{ color: '#cdff80' }}>Load more cards</Text>
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

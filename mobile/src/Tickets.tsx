import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { api } from './session';
import WalletButtons from './WalletButtons';
const ticketsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      venueName: z.string(),
      status: z.string(),
      startsAt: z.string(),
      timezone: z.string(),
    }),
  ),
});
const pendingSchema = z.object({
  data: z.array(z.object({ id: z.string(), email: z.string(), expiresAt: z.string() })),
});
const previewSchema = z.object({
  data: z.object({
    id: z.string(),
    ticketId: z.string(),
    title: z.string(),
    venueName: z.string(),
    terms: z.string(),
    tableTerms: z.string().nullable(),
    notice: z.string(),
  }),
});
export default function Tickets({
  selectedId,
  onSupport,
}: {
  selectedId?: string | null;
  onSupport: (id: string) => void;
}) {
  const [tickets, setTickets] = useState<z.infer<typeof ticketsSchema>['data']>([]),
    [after, setAfter] = useState<string | null>(null),
    [ticket, setTicket] = useState<Awaited<ReturnType<typeof api.ticket>>['data'] | null>(null),
    [pending, setPending] = useState<z.infer<typeof pendingSchema>['data']>([]),
    [email, setEmail] = useState(''),
    [token, setToken] = useState(''),
    [preview, setPreview] = useState<z.infer<typeof previewSchema>['data'] | null>(null),
    [accepted, setAccepted] = useState(false),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function load(more = false) {
    const rows = ticketsSchema.parse(
      await api.request(`/v1/tickets${more && after ? `?after=${after}` : ''}`),
    ).data;
    setTickets((previous) => (more ? [...previous, ...rows] : rows));
    setAfter(rows.length === 50 ? rows.at(-1)!.id : null);
  }
  async function open(id: string) {
    setTicket((await api.ticket(id)).data);
    setPending(pendingSchema.parse(await api.request(`/v1/tickets/${id}/transfers`)).data);
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unable to complete this action.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(() => load());
  }, []);
  useEffect(() => {
    if (selectedId) void act(() => open(selectedId));
  }, [selectedId]);
  return (
    <View style={s.box}>
      <Text style={s.heading}>Your tickets</Text>
      <Text style={s.text}>Includes tickets bought by others and transferred to you.</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(() => load())}>
        <Text style={s.text}>Refresh tickets</Text>
      </Pressable>
      {tickets.map((t) => (
        <Pressable
          accessibilityRole="button"
          key={t.id}
          style={s.box}
          onPress={() => void act(() => open(t.id))}
        >
          <Text style={s.text}>
            {t.title} · {t.venueName} · {t.status}
          </Text>
        </Pressable>
      ))}
      {after ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(() => load(true))}>
          <Text style={s.text}>Load more tickets</Text>
        </Pressable>
      ) : null}
      {ticket ? (
        <View style={s.box}>
          <Text style={s.heading}>{ticket.snapshot.title}</Text>
          <Text style={s.text}>
            {ticket.status} · {ticket.admittedAt ? 'Already admitted' : 'Not yet admitted'}
          </Text>
          <Text style={s.text}>
            {new Intl.DateTimeFormat(undefined, {
              timeZone: ticket.snapshot.timezone,
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(ticket.currentSchedule.startsAt))}
          </Text>
          {ticket.credential ? (
            <QRCode value={ticket.credential} size={220} />
          ) : (
            <Text style={s.text}>No active admission credential.</Text>
          )}
          <Text style={s.text}>{ticket.snapshot.terms}</Text>
          <Pressable accessibilityRole="button" onPress={() => onSupport(ticket.id)}>
            <Text style={s.text}>Get help with this ticket</Text>
          </Pressable>
          {ticket.credential ? <WalletButtons ticketId={ticket.id} /> : null}
          {ticket.status === 'valid' && !ticket.admittedAt ? (
            <>
              <Text style={s.text}>
                Transfer this admission to a verified email. Your QR remains valid until the recipient
                accepts; acceptance replaces it immediately.
              </Text>
              <TextInput
                accessibilityLabel="Transfer recipient email"
                autoCapitalize="none"
                keyboardType="email-address"
                style={s.input}
                value={email}
                onChangeText={setEmail}
              />
              <Pressable
                accessibilityRole="button"
                disabled={busy || !email || pending.length > 0}
                onPress={() =>
                  void act(async () => {
                    await api.post(`/v1/tickets/${ticket.id}/transfers`, { email }, Crypto.randomUUID());
                    await open(ticket.id);
                    setMessage('Invitation sent to the recipient email.');
                  })
                }
              >
                <Text style={s.text}>Send transfer invitation</Text>
              </Pressable>
              {pending.map((p) => (
                <View key={p.id}>
                  <Text style={s.text}>Waiting for {p.email}</Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() =>
                      void act(async () => {
                        await api.post(`/v1/ticket-transfers/${p.id}/revoke`, {});
                        await open(ticket.id);
                      })
                    }
                  >
                    <Text style={s.text}>Revoke invitation</Text>
                  </Pressable>
                </View>
              ))}
            </>
          ) : null}
        </View>
      ) : null}
      <Text style={s.heading}>Accept a transfer</Text>
      <TextInput
        accessibilityLabel="Transfer invitation code"
        autoCapitalize="none"
        style={s.input}
        value={token}
        onChangeText={(v) => {
          setToken(v);
          setPreview(null);
          setAccepted(false);
        }}
      />
      <Pressable
        accessibilityRole="button"
        disabled={busy || !token}
        onPress={() =>
          void act(async () =>
            setPreview(previewSchema.parse(await api.post('/v1/ticket-transfers/preview', { token })).data),
          )
        }
      >
        <Text style={s.text}>Review invitation</Text>
      </Pressable>
      {preview ? (
        <View style={s.box}>
          <Text style={s.heading}>{preview.title}</Text>
          <Text style={s.text}>{preview.venueName}</Text>
          <Text style={s.text}>{preview.terms}</Text>
          <Text style={s.text}>{preview.tableTerms}</Text>
          <Text style={s.text}>{preview.notice}</Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: accepted }}
            onPress={() => setAccepted(!accepted)}
          >
            <Text style={s.text}>{accepted ? '☑' : '☐'} I accept these terms and admission conditions.</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !accepted}
            onPress={() =>
              void act(async () => {
                await api.post('/v1/ticket-transfers/accept', { token, acceptTerms: true });
                await load();
                await open(preview.ticketId);
                setPreview(null);
                setToken('');
                setAccepted(false);
              })
            }
          >
            <Text style={s.text}>Accept ticket</Text>
          </Pressable>
        </View>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={s.text}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}
const s = StyleSheet.create({
  box: { borderWidth: 1, borderColor: '#394236', borderRadius: 12, padding: 16, gap: 12 },
  heading: { color: '#f7f6ef', fontSize: 22, fontWeight: '600' },
  text: { color: '#e1e5dc', fontSize: 16, lineHeight: 24 },
  input: { borderColor: '#596253', borderWidth: 1, padding: 12, color: '#e1e5dc', borderRadius: 8 },
});

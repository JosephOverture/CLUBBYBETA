import { useEffect, useRef, useState } from 'react';
import { AppState, View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import * as Crypto from 'expo-crypto';
import QRCode from 'react-native-qrcode-svg';
import { z } from 'zod';
import type { BookingGroup } from '@clubby/contracts';
import { orderSnapshotSchema } from '@clubby/contracts';
import { api } from './session';
const money = (v: number, c: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(v / 100);
export function GroupCreate({
  offer,
  guests,
  mode,
  onCreated,
}: {
  offer: { id: string; version: number; slotStartsAt: string };
  guests: number;
  mode: 'full' | 'deposit';
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('Friends at Clubby'),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const retry = useRef<{ base: string; key: string; input: unknown } | null>(null);
  async function create() {
    setBusy(true);
    setMessage('');
    try {
      const base = JSON.stringify({
        name,
        offerId: offer.id,
        expectedVersion: offer.version,
        guests,
        paymentMode: mode,
      });
      if (retry.current?.base !== base)
        retry.current = {
          base,
          key: Crypto.randomUUID(),
          input: {
            ...JSON.parse(base),
            deadline: new Date(
              Math.min(Date.now() + 20 * 60_000, Date.parse(offer.slotStartsAt) - 1000),
            ).toISOString(),
            acceptTerms: true,
            acceptBalanceResponsibility: true,
          },
        };
      const result = z
        .object({ data: z.object({ id: z.string() }) })
        .parse(await api.post('/v1/groups', retry.current.input, retry.current.key));
      retry.current = null;
      onCreated(result.data.id);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Group could not be created.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.box}>
      <Text style={s.heading}>Share the payment with a group</Text>
      <TextInput accessibilityLabel="Group name" value={name} onChangeText={setName} style={s.input} />
      <Text style={s.text}>
        The table is held for up to 20 minutes while members contribute. Unfinished funding is refunded to
        each payer. After confirmation, cancellation covers the whole unused table. Members see contribution
        amounts and names. The owner is responsible for any remaining balance before entry.
      </Text>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: accepted }}
        onPress={() => setAccepted(!accepted)}
      >
        <Text style={s.text}>
          {accepted ? '☑' : '☐'} I accept the displayed package and group terms and responsibility for the
          remaining balance.
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!accepted || busy || guests < 2}
        style={s.button}
        onPress={() => void create()}
      >
        <Text>{busy ? 'Creating…' : 'Create funding group'}</Text>
      </Pressable>
      {message ? (
        <Text accessibilityRole="alert" style={s.text}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}
const listSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), state: z.string() })),
});
const invitePreview = z.object({
  data: z.object({
    name: z.string(),
    terms: z.string(),
    deadline: z.string(),
    targetMinor: z.number(),
    currency: z.string(),
    snapshot: orderSnapshotSchema,
  }),
});
type ChatMessage = Awaited<ReturnType<typeof api.groupMessages>>['data'][number];
export default function Groups({
  userId,
  selectedId,
  onSelected,
  onPayment,
}: {
  userId: string;
  selectedId: string | null;
  onSelected: (id: string | null) => void;
  onPayment: (id: string) => void;
}) {
  const [list, setList] = useState<z.infer<typeof listSchema>['data']>([]),
    [group, setGroup] = useState<BookingGroup | null>(null),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [token, setToken] = useState(''),
    [preview, setPreview] = useState<z.infer<typeof invitePreview>['data'] | null>(null),
    [inviteAccepted, setInviteAccepted] = useState(false),
    [email, setEmail] = useState(''),
    [invite, setInvite] = useState<{ id: string; token: string } | null>(null),
    [amount, setAmount] = useState(''),
    [body, setBody] = useState(''),
    [reason, setReason] = useState(''),
    [retain, setRetain] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [ticket, setTicket] = useState<Awaited<ReturnType<typeof api.ticket>>['data'] | null>(null),
    [more, setMore] = useState(false);
  const cursor = useRef('0'),
    messageCursor = useRef('0'),
    generation = useRef(0),
    retry = useRef<{ value: string; key: string } | null>(null);
  async function command(path: string, input: unknown) {
    const value = JSON.stringify({ path, input });
    if (retry.current?.value !== value) retry.current = { value, key: Crypto.randomUUID() };
    const result = await api.post(path, input, retry.current.key);
    retry.current = null;
    return result;
  }
  async function loadList() {
    setList(listSchema.parse(await api.request('/v1/groups')).data);
  }
  async function loadMessages(id: string, reset = false) {
    const epoch = generation.current;
    const result = await api.groupMessages(id, reset ? '0' : messageCursor.current);
    if (epoch !== generation.current) return;
    messageCursor.current = result.meta.nextCursor;
    setMore(result.meta.hasMore);
    setMessages((previous) => {
      const combined = reset ? result.data : [...previous, ...result.data];
      return [...new Map(combined.map((m) => [m.id, m])).values()];
    });
  }
  async function refresh(id = selectedId) {
    const epoch = generation.current;
    await loadList();
    if (id) {
      const result = await api.group(id);
      if (epoch === generation.current) setGroup(result.data);
    }
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The group action could not be completed.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    generation.current++;
    cursor.current = '0';
    messageCursor.current = '0';
    setGroup(null);
    setMessages([]);
    setTicket(null);
    setInvite(null);
    setMessage('');
    let active = true,
      running = false;
    const epoch = generation.current;
    async function poll() {
      if (!active || running) return;
      running = true;
      try {
        await loadList();
        if (selectedId) {
          const updates = await api.groupUpdates(selectedId, cursor.current);
          if (!active) return;
          cursor.current = updates.meta.nextCursor;
          const result = await api.group(selectedId);
          if (!active) return;
          setGroup(result.data);
          const reset = updates.data.some((e) => e.kind === 'moderation');
          if (reset || updates.data.some((e) => e.kind === 'message') || messageCursor.current === '0')
            await loadMessages(selectedId, reset);
        }
      } catch (e) {
        if (active && epoch === generation.current) {
          setMessage(e instanceof Error ? e.message : 'Group updates are unavailable.');
          setGroup(null);
          setMessages([]);
        }
      } finally {
        running = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000),
      subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') void poll();
      });
    return () => {
      active = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [selectedId, userId]);
  const button = (label: string, fn: () => Promise<void>, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy || disabled}
      onPress={() => void action(fn)}
      style={s.link}
    >
      <Text style={s.text}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={s.box}>
      <Text style={s.heading}>Your groups</Text>
      <TextInput
        accessibilityLabel="Group invitation code"
        placeholder="Invitation code"
        value={token}
        onChangeText={(v) => {
          setToken(v);
          setPreview(null);
          setInviteAccepted(false);
        }}
        autoCapitalize="none"
        style={s.input}
      />
      {button('Review invitation', async () =>
        setPreview(invitePreview.parse(await api.post('/v1/group-invitations/preview', { token })).data),
      )}
      {preview ? (
        <View style={s.box}>
          <Text style={s.text}>
            {preview.name} · {money(preview.targetMinor, preview.currency)}
          </Text>
          <Text style={s.text}>{preview.terms}</Text>
          <Text style={s.text}>{preview.snapshot.table?.terms}</Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: inviteAccepted }}
            onPress={() => setInviteAccepted(!inviteAccepted)}
          >
            <Text style={s.text}>{inviteAccepted ? '☑' : '☐'} Accept these group terms</Text>
          </Pressable>
          {button(
            'Join group',
            async () => {
              const result = z
                .object({ data: z.object({ groupId: z.string() }) })
                .parse(await api.post('/v1/group-invitations/accept', { token, acceptTerms: true }));
              setPreview(null);
              setToken('');
              onSelected(result.data.groupId);
            },
            !inviteAccepted,
          )}
        </View>
      ) : null}
      {list.map((g) => (
        <Pressable key={g.id} accessibilityRole="button" disabled={busy} onPress={() => onSelected(g.id)}>
          <Text style={s.text}>
            {selectedId === g.id ? '●' : '○'} {g.name} · {g.state}
          </Text>
        </Pressable>
      ))}
      {group ? (
        <View style={s.box}>
          <Text style={s.heading}>{group.name}</Text>
          <Text style={s.text}>
            {group.state} · Confirmed {money(group.paidMinor, group.currency)} of{' '}
            {money(group.targetMinor, group.currency)}
          </Text>
          <Text style={s.text}>
            Still available to contribute: {money(group.remainingMinor, group.currency)}. Pending payments
            reserve their amounts.
          </Text>
          <Text style={s.text}>
            Funding deadline:{' '}
            {new Date(group.deadline).toLocaleString(undefined, { timeZone: group.snapshot.timezone })} (
            {group.snapshot.timezone})
          </Text>
          <Text style={s.text}>
            At-door balance: {money(group.balanceDueMinor, group.currency)} · Responsible owner:{' '}
            {group.members.find((m) => m.id === group.ownerId)?.displayName}
          </Text>
          <Text style={s.text}>{group.terms}</Text>
          <Text style={s.text}>{group.snapshot.table?.terms}</Text>
          {group.disputeOpen ? (
            <Text accessibilityRole="alert" style={s.text}>
              Payments need review. Admission is unavailable while the financial issue is unresolved.
            </Text>
          ) : null}
          {group.state === 'funding' ? (
            <>
              <TextInput
                accessibilityLabel={`Contribution amount in ${group.currency}`}
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={setAmount}
                style={s.input}
              />
              {button('Accept terms and review my contribution payment', async () => {
                const result = z.object({ data: z.object({ orderId: z.string() }) }).parse(
                  await command(`/v1/groups/${group.id}/contributions`, {
                    amountMinor: Math.round(Number(amount) * 100),
                    acceptTerms: true,
                  }),
                );
                onPayment(result.data.orderId);
                await refresh();
              })}
            </>
          ) : null}
          {group.contributions.map((c) => (
            <View key={c.id} style={s.box}>
              <Text style={s.text}>
                {c.displayName} · {money(c.amountMinor, group.currency)} · {c.status}{' '}
                {c.refundedMinor ? `· returned ${money(c.refundedMinor, group.currency)}` : ''}
              </Text>
              {c.orderId
                ? button('Open my payment / refund record', async () => onPayment(c.orderId!))
                : null}
              {c.userId === userId &&
              group.state === 'funding' &&
              !['refunded', 'cancelled'].includes(c.status)
                ? button('Withdraw my contribution', async () => {
                    await api.post(`/v1/groups/${group.id}/contributions/${c.id}/withdraw`, {});
                    await refresh();
                  })
                : null}
            </View>
          ))}
          {group.tickets.map((t) => (
            <View key={t.id}>
              {button(`Show my admission · ${t.status}`, async () =>
                setTicket((await api.ticket(t.id)).data),
              )}
            </View>
          ))}
          {ticket ? (
            <View style={s.box}>
              <Text style={s.text}>
                {ticket.snapshot.venueName} · {ticket.status}
              </Text>
              {ticket.credential ? (
                <QRCode value={ticket.credential} size={200} />
              ) : (
                <Text style={s.text}>No active credential.</Text>
              )}
            </View>
          ) : null}
          {group.ownerId === userId && group.state === 'funding' ? (
            <>
              <TextInput
                accessibilityLabel="Invite member by email"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                style={s.input}
              />
              {button('Send group invitation', async () =>
                setInvite(
                  z
                    .object({ data: z.object({ id: z.string(), token: z.string() }) })
                    .parse(await api.post(`/v1/groups/${group.id}/invitations`, { email })).data,
                ),
              )}
              {invite ? (
                <>
                  <Text selectable style={s.text}>
                    Invitation code: {invite.token}
                  </Text>
                  {button('Revoke this invitation', async () => {
                    await api.post(`/v1/groups/${group.id}/invitations/${invite.id}/revoke`, {});
                    setInvite(null);
                  })}
                </>
              ) : null}
            </>
          ) : null}
          <TextInput
            accessibilityLabel="Reason for report, removal or cancellation"
            placeholder="Reason for a report or booking change"
            value={reason}
            onChangeText={setReason}
            multiline
            style={s.input}
          />
          {group.members
            .filter((m) => m.id !== userId && m.status === 'active')
            .map((m) => (
              <View key={m.id} style={s.box}>
                <Text style={s.text}>{m.displayName}</Text>
                {button('Block this member’s chat', async () => {
                  await api.post(`/v1/me/blocked-users/${m.id}`, { blocked: true });
                  await loadMessages(group.id, true);
                })}
                {button('Unblock chat', async () => {
                  await api.post(`/v1/me/blocked-users/${m.id}`, { blocked: false });
                  await loadMessages(group.id, true);
                })}
                {group.ownerId === userId ? (
                  <>
                    {button('Offer group ownership', async () => {
                      await api.post(`/v1/groups/${group.id}/ownership`, { userId: m.id });
                      await refresh();
                    })}
                    {group.state === 'funding'
                      ? button('Remove unfunded member', async () => {
                          await api.post(`/v1/groups/${group.id}/members/${m.id}/remove`, {
                            reason,
                            retainConfirmedContribution: false,
                          });
                          await refresh();
                        })
                      : null}
                  </>
                ) : null}
              </View>
            ))}
          {group.ownerUnavailable && group.state === 'confirmed'
            ? button(
                'Accept vacant group ownership and responsibility for the remaining balance',
                async () => {
                  await api.post(`/v1/groups/${group.id}/ownership/recover`, {
                    acceptBalanceResponsibility: true,
                  });
                  await refresh();
                },
              )
            : null}
          {group.ownershipOffers
            .filter((o) => o.toUserId === userId)
            .map((o) => (
              <View key={o.id}>
                {button('Accept ownership and responsibility for the remaining balance', async () => {
                  await api.post(`/v1/groups/${group.id}/ownership/${o.id}/accept`, {
                    acceptBalanceResponsibility: true,
                  });
                  await refresh();
                })}
              </View>
            ))}
          {group.ownerId === userId ? (
            button('Cancel group and request applicable contributor refunds', async () => {
              await api.post(`/v1/groups/${group.id}/cancel`, { reason });
              await refresh();
            })
          ) : (
            <>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: retain }}
                onPress={() => setRetain(!retain)}
              >
                <Text style={s.text}>
                  {retain ? '☑' : '☐'} If confirmed, I understand my contribution and booking remain when I
                  leave the conversation.
                </Text>
              </Pressable>
              {button('Leave group conversation', async () => {
                await api.post(`/v1/groups/${group.id}/leave`, {
                  reason,
                  retainConfirmedContribution: retain,
                });
                onSelected(null);
                await loadList();
              })}
            </>
          )}
          <Text style={s.heading}>Group conversation</Text>
          {messages.map((m) => (
            <View style={s.box} key={m.id}>
              <Text style={s.text}>
                {m.displayName} · {new Date(m.createdAt).toLocaleString()}
              </Text>
              <Text selectable style={s.text}>
                {m.body}
              </Text>
              {button('Report message', async () => {
                await api.post(`/v1/groups/${group.id}/messages/${m.id}/report`, { reason });
                setMessage('The report is ready for moderation review.');
              })}
            </View>
          ))}
          {more ? button('Load more messages', async () => loadMessages(group.id)) : null}
          <TextInput
            accessibilityLabel="Message to the group"
            multiline
            maxLength={2000}
            value={body}
            onChangeText={setBody}
            style={s.input}
          />
          {button('Send message', async () => {
            await command(`/v1/groups/${group.id}/messages`, { body });
            setBody('');
            await loadMessages(group.id);
          })}
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
  box: { gap: 12, borderWidth: 1, borderColor: '#394236', borderRadius: 12, padding: 16 },
  text: { color: '#e1e5dc', fontSize: 15, lineHeight: 22 },
  heading: { color: '#f7f6ef', fontSize: 22 },
  input: { color: '#e1e5dc', borderWidth: 1, borderColor: '#596253', borderRadius: 8, padding: 12 },
  button: { backgroundColor: '#cdff80', borderRadius: 8, padding: 14 },
  link: { paddingVertical: 7 },
});

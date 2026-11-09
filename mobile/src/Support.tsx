import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { api } from './session';
export type SupportDraft = { kind: 'booking' | 'ticket'; id: string };
export const accessSchema = z.object({
  data: z.object({
    platform: z.array(z.string()),
    organizations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        role: z.string(),
        venueIds: z.array(z.string()).nullable(),
        permissions: z.array(z.string()),
      }),
    ),
  }),
});
export type Access = z.infer<typeof accessSchema>['data'];
const supportCase = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.enum(['open', 'waiting', 'resolved']),
  version: z.number(),
  user_id: z.string(),
  order_id: z.string(),
  ticket_id: z.string().nullable(),
  assigned_to: z.string().nullable(),
});
const entry = z.object({
  id: z.string(),
  sequence: z.string(),
  actor_id: z.string(),
  body: z.string(),
  created_at: z.string(),
});
const viewSchema = z.object({
  data: supportCase.extend({ messages: z.array(entry) }),
  meta: z.object({ nextCursor: z.string(), hasMore: z.boolean() }),
});
export default function Support({
  userId,
  access,
  selectedId,
  onSelected,
  draft,
  onDraft,
}: {
  userId: string;
  access: Access | null;
  selectedId: string | null;
  onSelected: (id: string | null) => void;
  draft: SupportDraft | null;
  onDraft: (draft: SupportDraft | null) => void;
}) {
  const [scope, setScope] = useState('me'),
    [filter, setFilter] = useState('open'),
    [cases, setCases] = useState<z.infer<typeof supportCase>[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<z.infer<typeof viewSchema> | null>(null),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [status, setStatus] = useState<'open' | 'waiting' | 'resolved'>('open'),
    [agents, setAgents] = useState<{ id: string; name: string }[]>([]),
    [assignee, setAssignee] = useState<string | null>(null),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const platform = Boolean(access?.platform.some((p) => ['admin', 'support'].includes(p)));
  const scopes = [
    { id: 'me', name: 'My cases' },
    ...(platform ? [{ id: 'platform', name: 'Platform support' }] : []),
    ...(access?.organizations
      .filter((o) => o.permissions.includes('support.manage'))
      .map((o) => ({ id: o.id, name: o.name })) ?? []),
  ];
  async function load(more = false) {
    const params = new URLSearchParams();
    if (filter) params.set('status', filter);
    if (scope !== 'me' && scope !== 'platform') params.set('organizationId', scope);
    if (more && cursor) params.set('before', cursor);
    const result = z
      .object({ data: z.array(supportCase), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`${scope === 'platform' ? '/v1/admin/support' : '/v1/support'}?${params}`));
    setCases((previous) => (more ? [...previous, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  async function open(id: string, more = false) {
    const result = viewSchema.parse(
      await api.request(`/v1/support/${id}${more && detail ? `?after=${detail.meta.nextCursor}` : ''}`),
    );
    setDetail((previous) =>
      more && previous
        ? {
            ...result,
            data: { ...result.data, messages: [...previous.data.messages, ...result.data.messages] },
          }
        : result,
    );
    setAssignee(result.data.assigned_to);
    if (!more)
      setStatus(
        result.data.status === 'waiting' && result.data.user_id === userId ? 'open' : result.data.status,
      );
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unable to complete this support action.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(() => load());
  }, [scope, filter, userId]);
  useEffect(() => {
    setDetail(null);
    if (selectedId) void act(() => open(selectedId));
  }, [selectedId]);
  useEffect(() => {
    if (draft) {
      setSubject('');
      setBody('');
      onSelected(null);
    }
  }, [draft?.id, draft?.kind]);
  useEffect(() => {
    if (platform)
      void api
        .request('/v1/admin/support/agents')
        .then((value) =>
          setAgents(
            z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(value).data,
          ),
        )
        .catch(() => {});
  }, [platform]);
  return (
    <View style={s.box}>
      <Text style={s.heading}>Support</Text>
      <View style={s.row}>
        {scopes.map((v) => (
          <Pressable
            key={v.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: scope === v.id }}
            onPress={() => {
              setScope(v.id);
              onSelected(null);
            }}
          >
            <Text style={s.link}>
              {scope === v.id ? '● ' : ''}
              {v.name}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={s.row}>
        {['open', 'waiting', 'resolved', ''].map((v) => (
          <Pressable key={v} accessibilityRole="button" onPress={() => setFilter(v)}>
            <Text style={s.link}>
              {filter === v ? '● ' : ''}
              {v || 'All cases'}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() =>
          void act(async () => {
            await load();
            if (selectedId) await open(selectedId);
          })
        }
      >
        <Text style={s.link}>Refresh cases</Text>
      </Pressable>
      {cases.map((c) => (
        <Pressable
          key={c.id}
          accessibilityRole="button"
          onPress={() => {
            onDraft(null);
            onSelected(c.id);
            setBody('');
          }}
        >
          <Text style={s.text}>
            {c.subject} · {c.status}
          </Text>
        </Pressable>
      ))}
      {!cases.length ? (
        <Text style={s.text}>No cases match this view. Open a booking or ticket to request help.</Text>
      ) : null}
      {cursor ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(() => load(true))}>
          <Text style={s.link}>Load more cases</Text>
        </Pressable>
      ) : null}
      {draft ? (
        <View style={s.box}>
          <Text style={s.heading}>Help with your {draft.kind}</Text>
          <Text style={s.text}>
            Tell us what happened. Do not include payment card numbers or sign-in codes.
          </Text>
          <TextInput
            accessibilityLabel="Support subject"
            style={s.input}
            value={subject}
            onChangeText={setSubject}
            placeholder="Subject"
            placeholderTextColor="#a8b1a1"
            maxLength={150}
          />
          <TextInput
            accessibilityLabel="Support question"
            style={s.input}
            multiline
            value={body}
            onChangeText={setBody}
            placeholder="How can we help?"
            placeholderTextColor="#a8b1a1"
            maxLength={5000}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || subject.trim().length < 5 || body.trim().length < 10}
            onPress={() =>
              void act(async () => {
                const response = z
                  .object({ data: z.object({ id: z.string() }) })
                  .parse(
                    await api.post(
                      `/v1/${draft.kind === 'ticket' ? 'tickets' : 'orders'}/${draft.id}/support`,
                      { subject, message: body },
                      Crypto.randomUUID(),
                    ),
                  );
                onDraft(null);
                onSelected(response.data.id);
                setBody('');
                await load();
              })
            }
          >
            <Text style={s.link}>Send request</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => onDraft(null)}>
            <Text style={s.link}>Cancel draft</Text>
          </Pressable>
        </View>
      ) : null}
      {detail ? (
        <View style={s.box}>
          <Text style={s.heading}>{detail.data.subject}</Text>
          <Text style={s.text}>{detail.data.status}</Text>
          {detail.data.messages.map((m) => (
            <View key={m.id}>
              <Text style={s.note}>
                {m.actor_id === userId ? 'You' : m.actor_id === detail.data.user_id ? 'Customer' : 'Support'}{' '}
                · {new Date(m.created_at).toLocaleString()}
              </Text>
              <Text selectable style={s.text}>
                {m.body}
              </Text>
            </View>
          ))}
          {detail.meta.hasMore ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void act(() => open(detail.data.id, true))}
            >
              <Text style={s.link}>Load later messages</Text>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel="Support reply"
            style={s.input}
            multiline
            value={body}
            onChangeText={setBody}
            maxLength={5000}
            placeholder="Write a reply"
            placeholderTextColor="#a8b1a1"
          />
          <View style={s.row}>
            {(['open', 'waiting', 'resolved'] as const)
              .filter((v) => v !== 'waiting' || detail.data.user_id !== userId)
              .map((v) => (
                <Pressable
                  key={v}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: status === v }}
                  onPress={() => setStatus(v)}
                >
                  <Text style={s.link}>
                    {status === v ? '●' : '○'} {v}
                  </Text>
                </Pressable>
              ))}
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !body.trim()}
            onPress={() =>
              void act(async () => {
                await api.post(
                  `/v1/support/${detail.data.id}/messages`,
                  { message: body, status, expectedVersion: detail.data.version },
                  Crypto.randomUUID(),
                );
                setBody('');
                await open(detail.data.id);
                await load();
              })
            }
          >
            <Text style={s.link}>Send reply and update status</Text>
          </Pressable>
          {platform ? (
            <>
              <Text style={s.text}>Assigned agent</Text>
              <View style={s.row}>
                {[{ id: '', name: 'Unassigned' }, ...agents].map((a) => (
                  <Pressable
                    key={a.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: (assignee ?? '') === a.id }}
                    onPress={() => setAssignee(a.id || null)}
                  >
                    <Text style={s.link}>
                      {(assignee ?? '') === a.id ? '●' : '○'} {a.name || a.id}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                accessibilityLabel="Assignment reason"
                style={s.input}
                value={reason}
                onChangeText={setReason}
              />
              <Pressable
                accessibilityRole="button"
                disabled={busy || reason.trim().length < 10}
                onPress={() =>
                  void act(async () => {
                    await api.post(`/v1/admin/support/${detail.data.id}/assignment`, {
                      userId: assignee,
                      reason,
                      expectedVersion: detail.data.version,
                    });
                    await open(detail.data.id);
                    setReason('');
                  })
                }
              >
                <Text style={s.link}>Update assignment</Text>
              </Pressable>
            </>
          ) : null}
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
  box: { gap: 12, padding: 16, borderWidth: 1, borderColor: '#394236', borderRadius: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  heading: { color: '#f7f6ef', fontSize: 22 },
  text: { color: '#e1e5dc', fontSize: 16, lineHeight: 24 },
  note: { color: '#a8b1a1', fontSize: 14 },
  link: { color: '#cdff80', fontSize: 16, paddingVertical: 8 },
  input: { borderWidth: 1, borderColor: '#596253', padding: 12, color: '#e1e5dc', borderRadius: 8 },
});

import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import PushRegistration from './PushRegistration';
export type NotificationTarget = { kind: 'booking' | 'ticket' | 'group' | 'support'; id: string };
const item = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
  target: z
    .object({ kind: z.enum(['booking', 'ticket', 'group', 'support']), id: z.string().uuid() })
    .nullable(),
});
const preference = z.object({
  locale: z.enum(['en', 'it']),
  timezone: z.string(),
  destinationId: z.string().nullable(),
  bookingEmail: z.boolean(),
  marketingEmail: z.boolean(),
  bookingPush: z.boolean(),
  marketingPush: z.boolean(),
  chatPush: z.boolean(),
  version: z.number(),
  pushAvailable: z.boolean(),
});
export default function Notifications({
  userId,
  onNavigate,
}: {
  userId: string;
  onNavigate: (target: NotificationTarget) => void;
}) {
  const [items, setItems] = useState<z.infer<typeof item>[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<z.infer<typeof item> | null>(null),
    [prefs, setPrefs] = useState<z.infer<typeof preference> | null>(null),
    [devices, setDevices] = useState<{ id: string; current: boolean; updatedAt: string }[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function inbox(more = false) {
    const response = z
      .object({ data: z.array(item), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/me/notifications${more && cursor ? `?before=${cursor}` : ''}`));
    setItems((previous) => (more ? [...previous, ...response.data] : response.data));
    setCursor(response.meta.nextCursor);
  }
  async function loadDevices() {
    setDevices(
      z
        .object({ data: z.array(z.object({ id: z.string(), current: z.boolean(), updatedAt: z.string() })) })
        .parse(await api.request('/v1/me/devices')).data,
    );
  }
  async function refresh() {
    await inbox();
    setPrefs(z.object({ data: preference }).parse(await api.request('/v1/me/preferences')).data);
    await loadDevices();
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unable to load account updates.');
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    // Push contains an opaque ID. The backend resolves its owner and target before navigation.
    const notification = z.object({ data: item }).parse(await api.request(`/v1/me/notifications/${id}`)).data;
    setSelected(notification);
    await api.post(`/v1/me/notifications/${id}/read`, {});
    await inbox();
  }
  useEffect(() => {
    void act(refresh);
  }, [userId]);
  const toggles = [
    ['bookingEmail', 'Booking updates by email'],
    ['bookingPush', 'Booking updates by push'],
    ['chatPush', 'Group message alerts'],
    ['marketingEmail', 'Offers and marketing by email'],
    ['marketingPush', 'Offers and marketing by push'],
  ] as const;
  return (
    <View style={s.box}>
      <Text style={s.heading}>Notifications and preferences</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(refresh)}>
        <Text style={s.link}>Refresh inbox</Text>
      </Pressable>
      {items.map((n) => (
        <Pressable key={n.id} accessibilityRole="button" onPress={() => void act(() => open(n.id))}>
          <Text style={s.text}>
            {n.readAt ? '' : '● '}
            {n.title} · {new Date(n.createdAt).toLocaleDateString()}
          </Text>
        </Pressable>
      ))}
      {items.length === 0 ? <Text style={s.text}>No account updates yet.</Text> : null}
      {cursor ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void act(() => inbox(true))}>
          <Text style={s.link}>Load older updates</Text>
        </Pressable>
      ) : null}
      {selected ? (
        <View style={s.box}>
          <Text style={s.heading}>{selected.title}</Text>
          <Text selectable style={s.text}>
            {selected.text}
          </Text>
          {selected.target ? (
            <Pressable accessibilityRole="button" onPress={() => onNavigate(selected.target!)}>
              <Text style={s.link}>Open {selected.target.kind}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {prefs ? (
        <>
          <Text style={s.text}>Essential sign-in emails remain enabled. Marketing is optional.</Text>
          {toggles.map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: prefs[key] }}
              onPress={() => setPrefs({ ...prefs, [key]: !prefs[key] })}
            >
              <Text style={s.text}>
                {prefs[key] ? '☑' : '☐'} {label}
              </Text>
            </Pressable>
          ))}
          <Text style={s.text}>Preferred language</Text>
          <View style={{ flexDirection: 'row', gap: 18 }}>
            {(['en', 'it'] as const).map((locale) => (
              <Pressable
                key={locale}
                accessibilityRole="radio"
                accessibilityState={{ selected: prefs.locale === locale }}
                onPress={() => setPrefs({ ...prefs, locale })}
              >
                <Text style={s.link}>
                  {prefs.locale === locale ? '●' : '○'} {locale === 'en' ? 'English' : 'Italiano'}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel="Preferred timezone"
            style={s.input}
            autoCapitalize="none"
            value={prefs.timezone}
            onChangeText={(timezone) => setPrefs({ ...prefs, timezone })}
          />
          <TextInput
            accessibilityLabel="Preferred destination"
            placeholder="Destination, e.g. milan"
            placeholderTextColor="#a8b1a1"
            style={s.input}
            autoCapitalize="none"
            value={prefs.destinationId ?? ''}
            onChangeText={(destinationId) => setPrefs({ ...prefs, destinationId: destinationId || null })}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              void act(async () => {
                const { version, pushAvailable, ...value } = prefs;
                setPrefs(
                  z
                    .object({ data: preference })
                    .parse(await api.post('/v1/me/preferences', { ...value, expectedVersion: version })).data,
                );
                setMessage('Preferences saved.');
              })
            }
          >
            <Text style={s.link}>Save preferences</Text>
          </Pressable>
          <PushRegistration
            userId={userId}
            enabled={prefs.pushAvailable}
            onOpen={(id) => void act(() => open(id))}
            onRegistered={() => void loadDevices().catch(() => {})}
          />
        </>
      ) : null}
      {devices.map((d) => (
        <View key={d.id}>
          <Text style={s.text}>
            {d.current ? 'This session' : 'Another iPhone session'} · last registered{' '}
            {new Date(d.updatedAt).toLocaleDateString()}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              void act(async () => {
                await api.post(`/v1/me/devices/${d.id}/remove`, {});
                await loadDevices();
              })
            }
          >
            <Text style={s.link}>Remove push device</Text>
          </Pressable>
        </View>
      ))}
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
  heading: { color: '#f7f6ef', fontSize: 22 },
  text: { color: '#e1e5dc', fontSize: 16, lineHeight: 24 },
  link: { color: '#cdff80', fontSize: 16, paddingVertical: 8 },
  input: { borderWidth: 1, borderColor: '#596253', padding: 12, color: '#e1e5dc', borderRadius: 8 },
});

import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import * as Crypto from 'expo-crypto';
import { ClubbyApiError } from '@clubby/api-client';
import { tableReservationSchema } from '@clubby/contracts';
import { z } from 'zod';
import { api } from './session';
import { GroupCreate } from './Groups';
const money = (v: number, c: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(v / 100);
const describe = (e: unknown) => (e instanceof Error ? e.message : 'The action could not be completed.');
export function BuyTable({
  occurrenceId,
  email,
  onBooked,
  onGroupCreated,
}: {
  occurrenceId: string;
  email: string | null;
  onBooked: (id: string) => void;
  onGroupCreated: (id: string) => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.tables>>['data'] | null>(null),
    [tableId, setTableId] = useState(''),
    [offerId, setOfferId] = useState(''),
    [guests, setGuests] = useState('4'),
    [mode, setMode] = useState<'full' | 'deposit'>('full'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    api
      .tables(occurrenceId)
      .then((r) => {
        if (active) setData(r.data);
      })
      .catch((e) => {
        if (active && (!(e instanceof ClubbyApiError) || e.status !== 404))
          setMessage('Table availability could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [occurrenceId]);
  const offer = data?.offers.find((o) => o.id === offerId);
  async function reserve() {
    if (!offer || !email) return;
    setBusy(true);
    setMessage('');
    try {
      const input = {
        offerId: offer.id,
        expectedVersion: offer.version,
        guests: Number(guests),
        paymentMode: mode,
        email,
      };
      const payload = JSON.stringify(input);
      if (retry.current?.payload !== payload) retry.current = { payload, key: Crypto.randomUUID() };
      const result = await api.reserveTable(input, retry.current.key);
      retry.current = null;
      onBooked(result.data.order.id);
    } catch (e) {
      setMessage(describe(e));
    } finally {
      setBusy(false);
    }
  }
  if (!data) return message ? <Text style={s.text}>{message}</Text> : null;
  return (
    <View style={s.box}>
      <Text style={s.heading}>Reserve a table</Text>
      <Text style={s.text}>{data.content.name}</Text>
      <View
        accessibilityLabel="Venue table plan"
        style={{ height: 280, position: 'relative', borderWidth: 1, borderColor: '#596253' }}
      >
        {data.content.tables.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            accessibilityLabel={`Table ${t.label}, ${t.seats} seats`}
            onPress={() => {
              setTableId(t.id);
              setOfferId('');
            }}
            style={{
              position: 'absolute',
              left: `${(t.x - t.width / 2) * 100}%`,
              top: `${(t.y - t.height / 2) * 100}%`,
              width: `${t.width * 100}%`,
              height: `${t.height * 100}%`,
              transform: [{ rotate: `${t.rotation}deg` }],
              borderRadius: t.shape === 'circle' ? 100 : 4,
              backgroundColor: tableId === t.id ? '#cdff80' : '#596253',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {data.offers
        .filter((o) => o.tableId === tableId)
        .map((o) => (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: offerId === o.id, disabled: !o.available }}
            disabled={!o.available}
            onPress={() => {
              setOfferId(o.id);
              setMode('full');
            }}
            style={s.box}
          >
            <Text style={s.text}>
              {offerId === o.id ? '●' : '○'}{' '}
              {new Date(o.slotStartsAt).toLocaleString(undefined, { timeZone: data.timezone })} –{' '}
              {new Date(o.slotEndsAt).toLocaleTimeString(undefined, { timeZone: data.timezone })} (
              {data.timezone}) · {money(o.fullPriceMinor, data.currency)} ·{' '}
              {o.available ? `${o.minGuests}–${o.maxGuests} guests` : 'Unavailable'}
            </Text>
          </Pressable>
        ))}
      {!tableId ? <Text style={s.text}>Choose a table to see its times and packages.</Text> : null}
      {offer ? (
        <>
          <Text style={s.text}>{offer.inclusions}</Text>
          <Text style={s.text}>{offer.terms}</Text>
          <Text style={s.text}>Guests</Text>
          <TextInput
            accessibilityLabel="Guests at this table"
            keyboardType="number-pad"
            value={guests}
            onChangeText={setGuests}
            style={s.input}
          />
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: mode === 'full' }}
            onPress={() => setMode('full')}
          >
            <Text style={s.text}>
              {mode === 'full' ? '●' : '○'} Pay full package: {money(offer.fullPriceMinor, data.currency)}
            </Text>
          </Pressable>
          {offer.depositMinor !== null ? (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === 'deposit' }}
              onPress={() => setMode('deposit')}
            >
              <Text style={s.text}>
                {mode === 'deposit' ? '●' : '○'} Pay deposit: {money(offer.depositMinor, data.currency)}.
                Remaining {money(offer.fullPriceMinor - offer.depositMinor, data.currency)} payable to the
                venue before entry.
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !email}
            onPress={() => void reserve()}
            style={s.button}
          >
            <Text>{busy ? 'Reserving…' : email ? 'Review table booking' : 'Sign in to reserve'}</Text>
          </Pressable>
          {email ? (
            <GroupCreate offer={offer} guests={Number(guests)} mode={mode} onCreated={onGroupCreated} />
          ) : null}
        </>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={s.text}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}
const staffSchema = tableReservationSchema.extend({
  collections: z.array(
    z.object({
      id: z.string(),
      amountMinor: z.number(),
      method: z.string(),
      reference: z.string(),
      reason: z.string(),
      reversalOf: z.string().nullable(),
    }),
  ),
});
export function TableDoor({ reservationId }: { reservationId: string | null }) {
  const [id, setId] = useState(reservationId ?? ''),
    [data, setData] = useState<z.infer<typeof staffSchema> | null>(null),
    [amount, setAmount] = useState(''),
    [method, setMethod] = useState<'cash' | 'external-card'>('cash'),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  async function load(value = id) {
    const result = z
      .object({ data: staffSchema })
      .parse(await api.request(`/v1/seller/table-reservations/${encodeURIComponent(value)}`));
    setData(result.data);
    setAmount(String(result.data.balanceDueMinor / 100));
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(describe(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (reservationId) {
      setId(reservationId);
      void action(() => load(reservationId));
    }
  }, [reservationId]);
  async function command(path: string, payload: unknown) {
    const serialized = JSON.stringify({ path, payload });
    if (retry.current?.payload !== serialized)
      retry.current = { payload: serialized, key: Crypto.randomUUID() };
    await api.post(path, payload, retry.current.key);
    retry.current = null;
    await load();
  }
  return (
    <View style={s.box}>
      <Text style={s.heading}>Table balances</Text>
      <TextInput
        accessibilityLabel="Table reservation reference"
        value={id}
        onChangeText={(v) => {
          setId(v);
          setData(null);
        }}
        style={s.input}
      />
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void action(() => load())}>
        <Text style={s.text}>Find reservation</Text>
      </Pressable>
      {data ? (
        <>
          <Text style={s.text}>
            Table {data.snapshot.table.label} · {data.guests} guests · {data.status}
          </Text>
          <Text style={s.text}>
            Balance due {money(data.balanceDueMinor, data.currency)} · Door refund due{' '}
            {money(data.doorRefundDueMinor, data.currency)}
          </Text>
          <TextInput
            accessibilityLabel="Payment receipt reference"
            placeholder="Receipt reference"
            value={reference}
            onChangeText={setReference}
            style={s.input}
          />
          <TextInput
            accessibilityLabel="Reason for payment record or correction"
            placeholder="Reason"
            value={reason}
            onChangeText={setReason}
            style={s.input}
          />
          {data.status === 'confirmed' && data.balanceDueMinor > 0 ? (
            <>
              <TextInput
                accessibilityLabel={`Amount collected in ${data.currency}`}
                keyboardType="decimal-pad"
                value={amount}
                onChangeText={setAmount}
                style={s.input}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => setMethod(method === 'cash' ? 'external-card' : 'cash')}
              >
                <Text style={s.text}>Payment received by: {method}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={s.button}
                onPress={() =>
                  void action(() =>
                    command(`/v1/seller/table-reservations/${data.id}/collections`, {
                      amountMinor: Math.round(Number(amount) * 100),
                      method,
                      reference,
                      reason,
                    }),
                  )
                }
              >
                <Text>Record received payment</Text>
              </Pressable>
            </>
          ) : null}
          {data.collections
            .filter((c) => c.amountMinor > 0 && !data.collections.some((r) => r.reversalOf === c.id))
            .map((c) => (
              <View key={c.id}>
                <Text style={s.text}>
                  {money(c.amountMinor, data.currency)} · {c.method} · {c.reference}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void action(() =>
                      command(`/v1/seller/door-collections/${c.id}/reverse`, { reference, reason }),
                    )
                  }
                >
                  <Text style={s.text}>Record full return / correction (manager)</Text>
                </Pressable>
              </View>
            ))}
          {data.status === 'confirmed' ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                void action(() => command(`/v1/seller/table-reservations/${data.id}/no-show`, { reason }))
              }
            >
              <Text style={s.text}>Mark no-show under booking terms (manager)</Text>
            </Pressable>
          ) : null}
        </>
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
});

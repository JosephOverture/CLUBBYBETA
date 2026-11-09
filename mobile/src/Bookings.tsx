import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import * as Crypto from 'expo-crypto';
import QRCode from 'react-native-qrcode-svg';
import type { Offer, Order, PaymentSession } from '@clubby/contracts';
import { api } from './session';
import Payment from './Payment';
import { ClubbyApiError } from '@clubby/api-client';
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
export function BuyTickets({
  occurrenceId,
  email,
  onBooked,
}: {
  occurrenceId: string;
  email: string | null;
  onBooked: (id: string) => void;
}) {
  const [offers, setOffers] = useState<Offer[]>([]),
    [selected, setSelected] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [extraDrinks, setExtraDrinks] = useState('0'),
    [promotionCode, setPromotionCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    api
      .offers(occurrenceId)
      .then((result) => {
        if (active) {
          setOffers(result.data);
          setSelected(result.data[0]?.id ?? '');
        }
      })
      .catch(() => {
        if (active) setError('Ticket availability could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [occurrenceId]);
  async function reserve() {
    if (!email || !selected) return;
    setBusy(true);
    setError('');
    try {
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 8) throw new Error('Choose 1–8 admissions.');
      const input = {
        occurrenceId,
        email,
        items: [{ productId: selected, quantity: qty, extraDrinks: Number(extraDrinks) }],
        ...(promotionCode.trim() ? { promotionCode: promotionCode.trim().toUpperCase() } : {}),
      };
      const payload = JSON.stringify(input);
      if (retry.current?.payload !== payload) retry.current = { payload, key: Crypto.randomUUID() };
      const result = await api.createOrder(input, retry.current.key);
      retry.current = null;
      onBooked(result.data.id);
    } catch (error) {
      setError(
        error instanceof ClubbyApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Checkout could not be reserved.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.container}>
      {offers.map((offer) => (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === offer.id }}
          key={offer.id}
          onPress={() => setSelected(offer.id)}
          style={s.card}
        >
          <Text style={s.text}>
            {selected === offer.id ? '●' : '○'} {offer.name} · {money(offer.priceMinor, offer.currency)}
          </Text>
          <Text style={s.note}>
            {offer.available} available · {offer.drinks} included drinks
          </Text>
          {offer.extraDrinkLimit > 0 ? (
            <Text style={s.note}>
              Extra drink vouchers: {money(offer.extraDrinkPriceMinor ?? 0, offer.currency)} each · up to{' '}
              {offer.extraDrinkLimit} per admission
            </Text>
          ) : null}
          {offer.admissionConditions ? <Text style={s.note}>{offer.admissionConditions}</Text> : null}
        </Pressable>
      ))}
      {offers.length ? (
        <>
          <TextInput
            accessibilityLabel="Number of admissions"
            keyboardType="number-pad"
            value={quantity}
            onChangeText={setQuantity}
            style={s.input}
          />
          <Text style={s.note}>
            Extra drink vouchers per admission (up to{' '}
            {offers.find((o) => o.id === selected)?.extraDrinkLimit ?? 0})
          </Text>
          <TextInput
            accessibilityLabel="Extra drink vouchers per admission"
            keyboardType="number-pad"
            value={extraDrinks}
            onChangeText={setExtraDrinks}
            style={s.input}
          />
          <Text style={s.note}>Promotion code (optional)</Text>
          <TextInput
            accessibilityLabel="Promotion code"
            value={promotionCode}
            onChangeText={setPromotionCode}
            autoCapitalize="characters"
            autoCorrect={false}
            style={s.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !email}
            onPress={() => void reserve()}
            style={s.button}
          >
            <Text>{busy ? 'Reserving…' : email ? 'Review booking and terms' : 'Sign in to book'}</Text>
          </Pressable>
        </>
      ) : (
        <Text style={s.note}>No ticket offers are currently published.</Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={s.text}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
export function MyBookings({
  selectedId,
  onSelected,
  userId,
  onGroupSelected,
  onSupport,
}: {
  selectedId: string | null;
  onSelected: (id: string | null) => void;
  userId: string;
  onGroupSelected: (id: string) => void;
  onSupport: (id: string) => void;
}) {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.orders>>['data']>([]),
    [order, setOrder] = useState<Order | null>(null),
    [payment, setPayment] = useState<PaymentSession | null>(null),
    [accepted, setAccepted] = useState(false),
    [useSavedMethods, setUseSavedMethods] = useState(false),
    [saveCard, setSaveCard] = useState(false),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [ticket, setTicket] = useState<Awaited<ReturnType<typeof api.ticket>>['data'] | null>(null);
  async function refresh() {
    setList((await api.orders()).data);
    if (selectedId) setOrder((await api.order(selectedId)).data);
  }
  useEffect(() => {
    setOrder(null);
    setPayment(null);
    setTicket(null);
    setAccepted(false);
    setUseSavedMethods(false);
    setSaveCard(false);
    void refresh().catch(() =>
      setMessage('Bookings could not be loaded. Sign in again if your session expired.'),
    );
  }, [selectedId]);
  useEffect(() => {
    if (!order || !['payment-pending', 'refund-pending'].includes(order.status)) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [order?.status, selectedId]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof ClubbyApiError
          ? error.message
          : 'Action could not be completed. Refresh the booking before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.container}>
      <Text style={s.heading}>Your bookings</Text>
      <Pressable accessibilityRole="button" onPress={() => void act(refresh)}>
        <Text style={s.text}>Refresh bookings</Text>
      </Pressable>
      {list.map((item) => (
        <Pressable
          accessibilityRole="button"
          key={item.id}
          onPress={() => onSelected(item.id)}
          style={s.card}
        >
          <Text style={s.text}>
            {item.snapshot.title} · {money(item.totalMinor, item.currency)}
          </Text>
          <Text style={s.note}>{item.status}</Text>
        </Pressable>
      ))}
      {order ? (
        <View style={s.card}>
          <Text style={s.heading}>{order.snapshot.title}</Text>
          <Text style={s.text}>
            {order.status} · {money(order.totalMinor, order.currency)}
          </Text>
          <Text style={s.note}>Booking {order.id}</Text>
          {order.groupId ? (
            <Pressable accessibilityRole="button" onPress={() => onGroupSelected(order.groupId!)}>
              <Text style={s.text}>Open group funding and conversation</Text>
            </Pressable>
          ) : null}
          {order.table ? (
            <View style={s.card}>
              <Text style={s.text}>
                Table {order.table.snapshot.table.label} · {order.table.guests} guests · {order.table.status}
              </Text>
              <Text style={s.note}>Reservation {order.table.id}</Text>
              <Text style={s.text}>
                Package {money(order.table.fullPriceMinor, order.currency)} · Online{' '}
                {money(order.table.onlineAmountMinor, order.currency)} · At door{' '}
                {money(order.table.doorCollectedMinor, order.currency)}
              </Text>
              <Text style={s.text}>
                Remaining before entry: {money(order.table.balanceDueMinor, order.currency)}
              </Text>
              {order.table.doorRefundDueMinor > 0 ? (
                <Text style={s.text}>
                  The venue must return {money(order.table.doorRefundDueMinor, order.currency)} collected at
                  the door.
                </Text>
              ) : null}
              <Text style={s.text}>{order.table.snapshot.inclusions}</Text>
              <Text style={s.text}>{order.table.snapshot.terms}</Text>
              {order.status === 'paid' &&
              order.tickets.every((t) => t.status === 'valid' && !t.admittedAt) ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void act(async () => {
                      await api.post(
                        `/v1/orders/${order.id}/refunds`,
                        {
                          ticketIds: order.tickets.map((t) => t.id),
                          reason: 'Customer requested cancellation of the complete table party',
                        },
                        Crypto.randomUUID(),
                      );
                      setTicket(null);
                      await refresh();
                    })
                  }
                >
                  <Text style={s.text}>Cancel and request refund for the entire table</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {order.paymentRole !== 'group-reservation' && ['held', 'payment-pending'].includes(order.status) ? (
            <>
              <Text style={s.text}>{order.snapshot.terms}</Text>
              <Text style={s.note}>
                Minimum age: {order.snapshot.minimumAge ?? 18}.{' '}
                {order.lines
                  .map((l) => l.snapshot.admissionConditions)
                  .filter(Boolean)
                  .join('\n')}
              </Text>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: accepted }}
                onPress={() => setAccepted(!accepted)}
              >
                <Text style={s.text}>
                  {accepted ? '☑' : '☐'} I accept these terms and admission conditions.
                </Text>
              </Pressable>
              {order.status === 'held' ? (
                <View style={{ gap: 12 }}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: useSavedMethods }}
                    onPress={() => {
                      setUseSavedMethods(!useSavedMethods);
                      setSaveCard(false);
                    }}
                  >
                    <Text style={s.text}>{useSavedMethods ? '☑' : '☐'} Use saved cards with this seller</Text>
                  </Pressable>
                  {useSavedMethods ? (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: saveCard }}
                      onPress={() => setSaveCard(!saveCard)}
                    >
                      <Text style={s.text}>
                        {saveCard ? '☑' : '☐'} Save the card used for this payment with this seller for future
                        checkouts. I can remove it in saved payment methods.
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={busy || !accepted}
                style={s.button}
                onPress={() =>
                  void act(async () => {
                    const result = await api.payment(
                      order.id,
                      order.status === 'held' ? { useSavedMethods, saveCard } : undefined,
                    );
                    setPayment(result.data);
                    await refresh();
                  })
                }
              >
                <Text>Continue to payment</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() =>
                  void act(async () => {
                    await api.post(`/v1/orders/${order.id}/cancel`, {});
                    setPayment(null);
                    await refresh();
                  })
                }
              >
                <Text style={s.text}>Cancel unpaid booking</Text>
              </Pressable>
            </>
          ) : null}
          {payment?.clientSecret && order.status === 'payment-pending' ? (
            <Payment payment={payment} onResult={() => void act(refresh)} />
          ) : null}
          {order.tickets.map((t) => (
            <View key={t.id} style={s.card}>
              <Text style={s.text}>
                Admission · {t.status}
                {t.admittedAt ? ' · checked in' : ''}
              </Text>
              {t.ownerId === userId ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void act(async () => setTicket((await api.ticket(t.id)).data))}
                >
                  <Text style={s.text}>Show ticket</Text>
                </Pressable>
              ) : (
                <Text style={s.note}>Assigned to another group member.</Text>
              )}
              {!order.table && t.status === 'valid' && !t.admittedAt ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void act(async () => {
                      await api.post(
                        `/v1/orders/${order.id}/refunds`,
                        { ticketIds: [t.id], reason: 'Customer requested refund from booking details' },
                        Crypto.randomUUID(),
                      );
                      setTicket(null);
                      await refresh();
                    })
                  }
                >
                  <Text style={s.text}>Request refund for this admission</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          {ticket ? (
            <View style={s.card}>
              <Text style={s.text}>
                {ticket.snapshot.venueName} · {ticket.status}
              </Text>
              <Text style={s.note}>
                {new Intl.DateTimeFormat(undefined, {
                  timeZone: ticket.snapshot.timezone,
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(ticket.currentSchedule.startsAt))}
              </Text>
              {ticket.credential ? (
                <QRCode value={ticket.credential} size={220} />
              ) : (
                <Text style={s.note}>No active admission credential.</Text>
              )}
            </View>
          ) : null}
          {order.refunds.map((r) => (
            <Text key={r.id} style={s.note}>
              Refund {money(r.amountMinor, order.currency)} · {r.status}
            </Text>
          ))}
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => onSupport(order.id)}>
            <Text style={s.text}>Contact booking support</Text>
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
  container: { gap: 14 },
  heading: { color: '#f7f6ef', fontSize: 22, fontWeight: '600' },
  text: { color: '#e1e5dc', fontSize: 16, lineHeight: 24 },
  note: { color: '#a8b1a1', fontSize: 14 },
  card: { borderWidth: 1, borderColor: '#394236', padding: 16, borderRadius: 12, gap: 10 },
  button: { backgroundColor: '#cdff80', borderRadius: 10, padding: 16, alignSelf: 'flex-start' },
  input: { color: '#e1e5dc', borderWidth: 1, borderColor: '#596253', padding: 12, borderRadius: 8 },
});

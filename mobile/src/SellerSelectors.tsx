import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, op, useAction } from './OperationsUI';

export const sellerVenue = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number(),
  timezone: z.string(),
  currency: z.string(),
});
export const sellerEvent = z.object({
  id: z.string(),
  title: z.string(),
  venue_id: z.string(),
  venue_name: z.string(),
  organization_id: z.string(),
  status: z.string(),
  version: z.number(),
});
export const occurrenceSchema = z.object({
  id: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  timezone: z.string(),
  currency: z.string(),
  capacity: z.number(),
  status: z.string(),
  version: z.number(),
});
export type SellerVenue = z.infer<typeof sellerVenue>;
export type SellerEvent = z.infer<typeof sellerEvent>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type SellerOrganization = { id: string; permissions: string[]; venueIds: string[] | null };
export const splitList = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export const decimalMinor = (value: string) => {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value.trim()))
    throw new Error('Enter a nonnegative amount with at most two decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
export function zonedInput(instant: string, timezone: string) {
  const date = new Date(instant);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  const local = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  const offset = Math.round((Date.parse(`${local}Z`) - date.getTime()) / 60000);
  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
}
export const eventTime = (o: Occurrence) =>
  `${new Date(o.starts_at).toLocaleString(undefined, { timeZone: o.timezone })} – ${new Date(o.ends_at).toLocaleString(undefined, { timeZone: o.timezone })} (${o.timezone}) · ${o.status}`;

export function VenuePicker({
  organizationId,
  value,
  onChange,
}: {
  organizationId: string;
  value: string;
  onChange: (venue: SellerVenue) => void;
}) {
  const action = useAction(),
    [venues, setVenues] = useState<SellerVenue[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(before?: string) {
    const result = z
      .object({ data: z.array(sellerVenue), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(
        await api.request(
          `/v1/organizations/${organizationId}/venues${before ? `?before=${encodeURIComponent(before)}` : ''}`,
        ),
      );
    setVenues((old) => (before ? [...old, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  useEffect(() => {
    void action.run(() => load());
  }, [organizationId]);
  return (
    <View style={{ gap: 8 }}>
      <Text style={op.text}>Select a venue</Text>
      <View style={op.row}>
        {venues.map((v) => (
          <Button
            key={v.id}
            label={`${value === v.id ? '✓ ' : ''}${v.name} · ${v.status}`}
            onPress={() => onChange(v)}
          />
        ))}
      </View>
      {cursor ? (
        <Button
          label="More venues"
          disabled={action.busy}
          onPress={() => void action.run(() => load(cursor))}
        />
      ) : null}
      <Button label="Refresh venues" disabled={action.busy} onPress={() => void action.run(() => load())} />
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

export function EventPicker({
  organizationId,
  value,
  onChange,
  ownedOnly = false,
}: {
  organizationId: string;
  value: string;
  onChange: (event: SellerEvent) => void;
  ownedOnly?: boolean;
}) {
  const action = useAction(),
    [events, setEvents] = useState<SellerEvent[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(before?: string) {
    const result = z
      .object({ data: z.array(sellerEvent), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(
        await api.request(`/v1/organizations/${organizationId}/events${before ? `?before=${before}` : ''}`),
      );
    setEvents((old) => (before ? [...old, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  useEffect(() => {
    void action.run(() => load());
  }, [organizationId]);
  return (
    <View style={{ gap: 8 }}>
      <Text style={op.text}>Select an event</Text>
      <View style={op.row}>
        {events
          .filter((e) => !ownedOnly || e.organization_id === organizationId)
          .map((e) => (
            <Button
              key={e.id}
              label={`${value === e.id ? '✓ ' : ''}${e.title} · ${e.venue_name} · ${e.status}`}
              onPress={() => onChange(e)}
            />
          ))}
      </View>
      {cursor ? (
        <Button
          label="More events"
          disabled={action.busy}
          onPress={() => void action.run(() => load(cursor))}
        />
      ) : null}
      <Button label="Refresh events" disabled={action.busy} onPress={() => void action.run(() => load())} />
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

export function OccurrencePicker({
  organizationId,
  value,
  onChange,
  optional = false,
  ownedOnly = false,
}: {
  organizationId: string;
  value: string;
  onChange: (occurrence: Occurrence | null) => void;
  optional?: boolean;
  ownedOnly?: boolean;
}) {
  const action = useAction(),
    [event, setEvent] = useState(''),
    [occurrences, setOccurrences] = useState<Occurrence[]>([]),
    sequence = useRef(0);
  async function select(e: SellerEvent) {
    const request = ++sequence.current;
    setEvent(e.id);
    setOccurrences([]);
    onChange(null);
    const response = z
      .object({ data: z.object({ occurrences: z.array(occurrenceSchema) }) })
      .parse(await api.request(`/v1/seller/events/${e.id}`));
    if (request === sequence.current) setOccurrences(response.data.occurrences);
  }
  return (
    <View style={{ gap: 8 }}>
      {optional ? (
        <Button
          label={`${!value ? '✓ ' : ''}All seller events`}
          onPress={() => {
            sequence.current++;
            setEvent('');
            setOccurrences([]);
            onChange(null);
          }}
        />
      ) : null}
      <EventPicker
        organizationId={organizationId}
        value={event}
        ownedOnly={ownedOnly}
        onChange={(e) => void action.run(() => select(e))}
      />
      {occurrences.map((o) => (
        <Button
          key={o.id}
          label={`${value === o.id ? '✓ ' : ''}${eventTime(o)}`}
          onPress={() => onChange(o)}
        />
      ))}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import { z } from 'zod';
import { venueListSchema, type Venue } from '@clubby/contracts';
import { api, apiOrigin } from './session';
import { Button, Field, op, useAction } from './OperationsUI';
import { BuyTickets } from './Bookings';
import { BuyTable } from './Tables';
const eventSchema = z.object({
  id: z.string(),
  occurrenceId: z.string(),
  title: z.string(),
  description: z.string(),
  lineup: z.array(z.string()),
  startsAt: z.string(),
  endsAt: z.string(),
  timezone: z.string(),
  commercialMode: z.string(),
  externalUrl: z.string().nullable(),
});
const imageOrigin = apiOrigin;
export default function Discovery({
  userId,
  email,
  onBooked,
  onGroupCreated,
}: {
  userId?: string;
  email: string | null;
  onBooked: (id: string) => void;
  onGroupCreated: (id: string) => void;
}) {
  const action = useAction(),
    [destinations, setDestinations] = useState<{ id: string; name: string }[]>([]),
    [city, setCity] = useState('milan'),
    [query, setQuery] = useState(''),
    [tag, setTag] = useState(''),
    [latitude, setLatitude] = useState(''),
    [longitude, setLongitude] = useState(''),
    [radius, setRadius] = useState('50'),
    [venues, setVenues] = useState<Venue[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [saved, setSaved] = useState<{ id: string; name: string }[]>([]),
    [savedCursor, setSavedCursor] = useState<string | null>(null),
    [detailSaved, setDetailSaved] = useState(false),
    [editorial, setEditorial] = useState<{ id: string; name: string }[]>([]),
    [detail, setDetail] = useState<Venue | null>(null),
    [banner, setBanner] = useState(''),
    [nativeCheckout, setNativeCheckout] = useState(false);
  const sequence = useRef(0);
  async function load(next?: string, initialCity?: string) {
    const params = new URLSearchParams({ city: initialCity ?? city, query, radiusKm: radius });
    if (tag.trim()) params.set('tag', tag.trim());
    if (latitude.trim() || longitude.trim()) {
      params.set('latitude', latitude);
      params.set('longitude', longitude);
    }
    const path = next ? search : `/v1/venues?${params.toString()}`;
    const response = venueListSchema.parse(
      await api.request(`${path}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`),
    );
    setVenues((old) => (next ? [...old, ...response.data] : response.data));
    setCursor(response.meta?.nextCursor ?? null);
    if (!next) setSearch(path);
  }
  async function savedVenues(after?: string) {
    if (!userId) {
      setSaved([]);
      setSavedCursor(null);
      return;
    }
    const result = z
      .object({
        data: z.array(z.object({ id: z.string(), name: z.string() })),
        meta: z.object({ nextCursor: z.string().nullable() }),
      })
      .parse(await api.request(`/v1/me/saved-venues${after ? '?after=' + encodeURIComponent(after) : ''}`));
    setSaved((old) => (after ? [...old, ...result.data] : result.data));
    setSavedCursor(result.meta.nextCursor);
  }
  async function select(id: string) {
    const current = ++sequence.current;
    setDetail(null);
    const response = await api.venue(id);
    const saved = userId
      ? z
          .object({ data: z.object({ saved: z.boolean() }) })
          .parse(await api.request(`/v1/me/saved-venues/${encodeURIComponent(id)}`)).data.saved
      : false;
    if (current === sequence.current) {
      setDetail(response.data);
      setDetailSaved(saved);
    }
  }
  useEffect(() => {
    void action.run(async () => {
      const result = z
        .object({ data: z.array(z.object({ id: z.string(), name: z.string() })) })
        .parse(await api.request('/v1/destinations'));
      setDestinations(result.data);
      const first = result.data.find((d) => d.id === 'milan')?.id ?? result.data[0]?.id;
      if (first) {
        setCity(first);
        await load(undefined, first);
      }
      const config = z
        .object({
          data: z.object({ capabilities: z.object({ nativeCheckout: z.boolean() }) }),
          settings: z.object({ banner: z.string() }),
        })
        .parse(await api.request('/v1/bootstrap'));
      setBanner(config.settings.banner);
      setNativeCheckout(config.data.capabilities.nativeCheckout);
      setEditorial(
        z
          .object({ data: z.object({ editorial: z.array(z.object({ id: z.string(), name: z.string() })) }) })
          .parse(await api.request('/v1/discover')).data.editorial,
      );
      await savedVenues();
    });
  }, [userId]);
  return (
    <View style={{ gap: 16 }}>
      <Text style={op.title}>Find your next night</Text>
      {banner ? <Text style={op.text}>{banner}</Text> : null}
      <View style={op.row}>
        {destinations.map((d) => (
          <Button
            key={d.id}
            label={`${city === d.id ? '✓ ' : ''}${d.name}`}
            disabled={action.busy}
            onPress={() => {
              setCity(d.id);
              setDetail(null);
              void action.run(() => load(undefined, d.id));
            }}
          />
        ))}
      </View>
      <Field label="Search venues" value={query} onChange={setQuery} />
      <Field label="Filter by tag (optional)" value={tag} onChange={setTag} />
      <Text style={op.text}>Optional nearby search</Text>
      <Field label="Search latitude" value={latitude} onChange={setLatitude} />
      <Field label="Search longitude" value={longitude} onChange={setLongitude} />
      <Field label="Search radius (km)" value={radius} onChange={setRadius} />
      <Button label="Search" disabled={action.busy} onPress={() => void action.run(() => load())} />
      {editorial.length ? (
        <>
          <Text style={op.title}>Featured venues</Text>
          <View style={op.row}>
            {editorial.map((v) => (
              <Button
                key={v.id}
                label={v.name}
                disabled={action.busy}
                onPress={() => void action.run(() => select(v.id))}
              />
            ))}
          </View>
        </>
      ) : null}
      {userId ? (
        <>
          <Text style={op.title}>Saved venues</Text>
          <Button
            label="Refresh saved venues"
            disabled={action.busy}
            onPress={() => void action.run(savedVenues)}
          />
          {saved.length ? (
            saved.map((v) => (
              <View key={v.id} style={op.row}>
                <Button
                  label={v.name}
                  disabled={action.busy}
                  onPress={() => void action.run(() => select(v.id))}
                />
                <Button
                  label={`Unsave ${v.name}`}
                  disabled={action.busy}
                  onPress={() =>
                    void action.run(async () => {
                      await api.post(`/v1/me/saved-venues/${encodeURIComponent(v.id)}`, { saved: false });
                      if (detail?.id === v.id) setDetailSaved(false);
                      await savedVenues();
                    })
                  }
                />
              </View>
            ))
          ) : (
            <Text style={op.text}>Your saved venues will appear here on both the app and website.</Text>
          )}
          {savedCursor ? (
            <Button
              label="More saved venues"
              disabled={action.busy}
              onPress={() => void action.run(() => savedVenues(savedCursor))}
            />
          ) : null}
        </>
      ) : null}
      <Text style={op.title}>Search results</Text>
      {venues.length === 0 && !action.busy ? <Text style={op.text}>No venues match this search.</Text> : null}
      {venues.map((v) => (
        <View key={v.id} style={op.box}>
          <Text style={op.title}>{v.name}</Text>
          <Text style={op.text}>{v.description}</Text>
          <Text style={op.text}>
            {v.openNow ? 'Open now' : 'Currently closed'}
            {v.distanceKm != null ? ` · ${v.distanceKm.toFixed(1)} km away` : ''}
          </Text>
          {v.heroMediaId ? (
            <Image
              source={{ uri: `${imageOrigin}/v1/media/${v.heroMediaId}/thumbnail` }}
              accessibilityLabel={v.name}
              style={{ height: 150, width: '100%' }}
            />
          ) : null}
          <Button
            label={`View ${v.name}`}
            disabled={action.busy}
            onPress={() => void action.run(() => select(v.id))}
          />
        </View>
      ))}
      {cursor ? (
        <Button
          label="More venues"
          disabled={action.busy}
          onPress={() => void action.run(() => load(cursor))}
        />
      ) : null}
      {detail ? (
        <View style={op.box}>
          <Button
            label="Close venue details"
            onPress={() => {
              sequence.current++;
              setDetail(null);
            }}
          />
          <Text style={op.title}>{detail.name}</Text>
          <Text style={op.text}>{detail.description}</Text>
          <Text style={op.text}>
            {detail.address} · minimum age {detail.minimumAge ?? 18} · {detail.timezone}
          </Text>
          {detail.demo ? <Text style={op.text}>Development listing · booking unavailable</Text> : null}
          {detail.latitude != null && detail.longitude != null ? (
            <Button
              label="Open venue location in Maps"
              onPress={() =>
                void action.run(async () => {
                  await Linking.openURL(
                    `https://maps.apple.com/?ll=${detail.latitude},${detail.longitude}&q=${encodeURIComponent(detail.name)}`,
                  );
                })
              }
            />
          ) : null}
          {userId ? (
            <Button
              label={detailSaved ? 'Unsave venue' : 'Save venue'}
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/me/saved-venues/${encodeURIComponent(detail.id)}`, {
                    saved: !detailSaved,
                  });
                  setDetailSaved(!detailSaved);
                  await savedVenues();
                })
              }
            />
          ) : null}
          <VenueEvents
            key={detail.id}
            venueId={detail.id}
            email={email}
            nativeCheckout={nativeCheckout}
            onBooked={onBooked}
            onGroupCreated={onGroupCreated}
          />
        </View>
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
function VenueEvents({
  venueId,
  email,
  nativeCheckout,
  onBooked,
  onGroupCreated,
}: {
  venueId: string;
  email: string | null;
  nativeCheckout: boolean;
  onBooked: (id: string) => void;
  onGroupCreated: (id: string) => void;
}) {
  const action = useAction(),
    [events, setEvents] = useState<z.infer<typeof eventSchema>[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  async function load(next?: string) {
    const result = z
      .object({ data: z.array(eventSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(
        await api.request(
          `/v1/venues/${encodeURIComponent(venueId)}/events${next ? '?cursor=' + encodeURIComponent(next) : ''}`,
        ),
      );
    setEvents((old) => (next ? [...old, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
    setLoaded(true);
  }
  useEffect(() => {
    void action.run(() => load());
  }, [venueId]);
  return (
    <View style={{ gap: 12 }}>
      <Button
        label="Refresh upcoming events"
        disabled={action.busy}
        onPress={() => void action.run(() => load())}
      />
      {loaded && !events.length ? <Text style={op.text}>No upcoming published events.</Text> : null}
      {events.map((e) => (
        <View key={e.occurrenceId} style={op.box}>
          <Text style={op.title}>{e.title}</Text>
          <Text style={op.text}>{e.description}</Text>
          <Text style={op.text}>
            {new Date(e.startsAt).toLocaleString(undefined, { timeZone: e.timezone })} ({e.timezone}) ·{' '}
            {e.lineup.join(', ')}
          </Text>
          {e.commercialMode === 'external' && e.externalUrl ? (
            <>
              <Text style={op.text}>
                You will purchase with the external seller. Their payment and cancellation terms apply.
              </Text>
              <Button
                label="Book with external seller"
                onPress={() =>
                  void action.run(async () => {
                    await Linking.openURL(e.externalUrl!);
                  })
                }
              />
            </>
          ) : e.commercialMode === 'native' && nativeCheckout ? (
            <>
              <BuyTickets occurrenceId={e.occurrenceId} email={email} onBooked={onBooked} />
              <BuyTable
                occurrenceId={e.occurrenceId}
                email={email}
                onBooked={onBooked}
                onGroupCreated={onGroupCreated}
              />
            </>
          ) : (
            <Text style={op.text}>Booking is not available for this event right now.</Text>
          )}
        </View>
      ))}
      {cursor ? (
        <Button
          label="More upcoming events"
          disabled={action.busy}
          onPress={() => void action.run(() => load(cursor))}
        />
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { venueListSchema } from '@clubby/contracts';
import { api } from './session';
import { Button, Field, op, useAction } from './OperationsUI';
export function PublicVenuePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: { id: string; name: string; timezone: string }) => void;
}) {
  const action = useAction(),
    [destinations, setDestinations] = useState<{ id: string; name: string }[]>([]),
    [city, setCity] = useState(''),
    [query, setQuery] = useState(''),
    [venues, setVenues] = useState<z.infer<typeof venueListSchema>['data']>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [search, setSearch] = useState('');
  useEffect(() => {
    void action.run(async () => {
      setDestinations(
        z
          .object({ data: z.array(z.object({ id: z.string(), name: z.string() })) })
          .parse(await api.request('/v1/destinations')).data,
      );
    });
  }, []);
  async function load(next?: string) {
    const path = next
      ? search
      : `/v1/venues?city=${encodeURIComponent(city)}&query=${encodeURIComponent(query)}`;
    const response = venueListSchema.parse(
      await api.request(`${path}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`),
    );
    if (!next) setSearch(path);
    setVenues((old) => (next ? [...old, ...response.data] : response.data));
    setCursor(response.meta?.nextCursor ?? null);
  }
  return (
    <View style={op.box}>
      <Text style={op.text}>Find a published venue</Text>
      <View style={op.row}>
        {destinations.map((d) => (
          <Button
            key={d.id}
            label={`${city === d.id ? '✓ ' : ''}${d.name}`}
            onPress={() => {
              setCity(d.id);
              setVenues([]);
              setCursor(null);
            }}
          />
        ))}
      </View>
      <Field label="Search venue name or description" value={query} onChange={setQuery} />
      <Button
        label="Find venues"
        disabled={action.busy || !city}
        onPress={() => void action.run(() => load())}
      />
      {venues.map((v) => (
        <Button key={v.id} label={`${value === v.id ? '✓ ' : ''}${v.name}`} onPress={() => onChange(v)} />
      ))}
      {cursor ? (
        <Button
          label="More search results"
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

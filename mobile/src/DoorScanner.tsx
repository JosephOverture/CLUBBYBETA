import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { api } from './session';
import { TableDoor } from './Tables';
export default function DoorScanner() {
  const [permission, requestPermission] = useCameraPermissions(),
    [events, setEvents] = useState<{ id: string; title: string; venueName: string }[]>([]),
    [selected, setSelected] = useState(''),
    [kind, setKind] = useState<'admission' | 'drink'>('admission'),
    [message, setMessage] = useState(''),
    [active, setActive] = useState(false),
    [retryAvailable, setRetryAvailable] = useState(false),
    [tableReservationId, setTableReservationId] = useState<string | null>(null);
  const pending = useRef<{
      credential: string;
      key: string;
      occurrenceId: string;
      kind: 'admission' | 'drink';
    } | null>(null),
    busy = useRef(false);
  useEffect(() => {
    let mounted = true;
    api
      .request('/v1/admissions/occurrences')
      .then((value) => {
        const data = z
          .object({ data: z.array(z.object({ id: z.string(), title: z.string(), venueName: z.string() })) })
          .parse(value).data;
        if (mounted) setEvents(data);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  async function submit(value: string) {
    if (busy.current || !selected) return;
    busy.current = true;
    setActive(false);
    setRetryAvailable(false);
    setMessage('Checking with Clubby…');
    if (!pending.current)
      pending.current = { credential: value, key: Crypto.randomUUID(), occurrenceId: selected, kind };
    const request = pending.current;
    try {
      const result = z
        .object({ data: z.object({ outcome: z.string(), tableReservationId: z.string().nullable() }) })
        .parse(
          await api.post(
            '/v1/admissions/scan',
            { occurrenceId: request.occurrenceId, kind: request.kind, credential: request.credential },
            request.key,
          ),
        );
      setMessage(result.data.outcome.replaceAll('-', ' '));
      setTableReservationId(result.data.tableReservationId);
      pending.current = null;
    } catch {
      setMessage('The scan could not be confirmed. Retry the same scan when online.');
      setRetryAvailable(true);
    } finally {
      busy.current = false;
    }
  }
  if (!events.length) return null;
  return (
    <View style={{ gap: 14, borderWidth: 1, borderColor: '#394236', padding: 20, borderRadius: 14 }}>
      <Text style={{ color: '#f7f6ef', fontSize: 22 }}>Door scanner</Text>
      {events.map((event) => (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === event.id }}
          disabled={busy.current || retryAvailable}
          key={event.id}
          onPress={() => {
            setSelected(event.id);
            setActive(false);
          }}
        >
          <Text style={{ color: '#e1e5dc' }}>
            {selected === event.id ? '●' : '○'} {event.venueName} · {event.title}
          </Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        disabled={retryAvailable}
        onPress={() => {
          setKind(kind === 'admission' ? 'drink' : 'admission');
          setActive(false);
        }}
      >
        <Text style={{ color: '#e1e5dc' }}>Mode: {kind}</Text>
      </Pressable>
      {!permission?.granted ? (
        <Pressable accessibilityRole="button" onPress={() => void requestPermission()}>
          <Text style={{ color: '#cdff80' }}>Allow camera for ticket scanning</Text>
        </Pressable>
      ) : null}
      {permission?.granted && selected && active ? (
        <CameraView
          style={{ height: 320 }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(event) => {
            if (/^[A-Za-z0-9_-]{43}$/.test(event.data)) void submit(event.data);
            else {
              setActive(false);
              setMessage('This is not a Clubby admission credential.');
            }
          }}
        />
      ) : null}
      {retryAvailable ? (
        <Pressable accessibilityRole="button" onPress={() => void submit(pending.current!.credential)}>
          <Text style={{ color: '#cdff80' }}>Retry this scan</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={!selected || !permission?.granted}
          onPress={() => {
            setActive(true);
            setMessage('');
          }}
        >
          <Text style={{ color: '#cdff80' }}>Scan next ticket</Text>
        </Pressable>
      )}
      <Text accessibilityRole="alert" style={{ color: '#e1e5dc' }}>
        {message}
      </Text>
      <TableDoor reservationId={tableReservationId} />
    </View>
  );
}

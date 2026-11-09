import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, Toggle, op, useAction } from './OperationsUI';
import { SellerMedia } from './SellerMedia';
import {
  EventPicker,
  VenuePicker,
  occurrenceSchema,
  eventTime,
  splitList,
  zonedInput,
  type SellerOrganization,
  type SellerVenue,
  type Occurrence,
} from './SellerSelectors';

type Interval = { opens: string; closes: string };
type Schedule = {
  weekly: { day: number; intervals: Interval[] }[];
  exceptions: { date: string; intervals: Interval[] }[];
};
const intervalSchema = z.object({ opens: z.string(), closes: z.string() });
const scheduleSchema = z.object({
  weekly: z.array(z.object({ day: z.number(), intervals: z.array(intervalSchema) })),
  exceptions: z.array(z.object({ date: z.string(), intervals: z.array(intervalSchema) })),
});
const venueSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  tags: z.array(z.string()),
  minimum_age: z.number(),
  address: z.string(),
  contact_url: z.string().nullable(),
  schedule: scheduleSchema,
  version: z.number(),
  status: z.string(),
});
function Intervals({ value, onChange }: { value: Interval[]; onChange: (v: Interval[]) => void }) {
  return (
    <View style={{ gap: 8 }}>
      {value.length === 0 ? <Text style={op.text}>Closed</Text> : null}
      {value.map((v, index) => (
        <View key={index} style={op.box}>
          <Field
            label="Opens (HH:mm)"
            value={v.opens}
            onChange={(opens) => onChange(value.map((x, i) => (i === index ? { ...x, opens } : x)))}
          />
          <Field
            label="Closes (HH:mm, next day if earlier than opening)"
            value={v.closes}
            onChange={(closes) => onChange(value.map((x, i) => (i === index ? { ...x, closes } : x)))}
          />
          <Button
            label="Remove opening interval"
            onPress={() => onChange(value.filter((_, i) => i !== index))}
          />
        </View>
      ))}
      {value.length < 4 ? (
        <Button
          label="Add opening interval"
          onPress={() => onChange([...value, { opens: '22:00', closes: '04:00' }])}
        />
      ) : null}
    </View>
  );
}
function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (v: Schedule) => void }) {
  const [day, setDay] = useState(5);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return (
    <View style={op.box}>
      <Text style={op.title}>Opening hours</Text>
      <Text style={op.text}>
        Hours use the venue’s local timezone. A dated exception overrides regular hours, including arrivals
        from the previous night.
      </Text>
      <View style={op.row}>
        {days.map((d, i) => (
          <Button key={d} label={`${i === day ? '✓ ' : ''}${d}`} onPress={() => setDay(i)} />
        ))}
      </View>
      <Intervals
        value={value.weekly.find((v) => v.day === day)?.intervals ?? []}
        onChange={(intervals) =>
          onChange({ ...value, weekly: [...value.weekly.filter((v) => v.day !== day), { day, intervals }] })
        }
      />
      <Text style={op.title}>Dated exceptions</Text>
      {value.exceptions.map((exception, index) => (
        <View key={index} style={op.box}>
          <Field
            label="Exception date (YYYY-MM-DD)"
            value={exception.date}
            onChange={(date) =>
              onChange({
                ...value,
                exceptions: value.exceptions.map((x, i) => (i === index ? { ...x, date } : x)),
              })
            }
          />
          <Intervals
            value={exception.intervals}
            onChange={(intervals) =>
              onChange({
                ...value,
                exceptions: value.exceptions.map((x, i) => (i === index ? { ...x, intervals } : x)),
              })
            }
          />
          <Button
            label="Remove dated exception"
            onPress={() => onChange({ ...value, exceptions: value.exceptions.filter((_, i) => i !== index) })}
          />
        </View>
      ))}
      <Button
        label="Add dated exception"
        disabled={value.exceptions.length >= 366}
        onPress={() => onChange({ ...value, exceptions: [...value.exceptions, { date: '', intervals: [] }] })}
      />
    </View>
  );
}
export function SellerVenues({ organization }: { organization: SellerOrganization }) {
  const [selected, setSelected] = useState<SellerVenue | null>(null),
    [creating, setCreating] = useState(false),
    [revision, setRevision] = useState(0);
  return (
    <View style={op.box}>
      <Text style={op.title}>Venues</Text>
      <VenuePicker
        key={revision}
        organizationId={organization.id}
        value={selected?.id ?? ''}
        onChange={(v) => {
          setSelected(v);
          setCreating(false);
        }}
      />
      {organization.venueIds === null && organization.permissions.includes('venue.edit') ? (
        <Button
          label="Create a venue"
          onPress={() => {
            setCreating(true);
            setSelected(null);
          }}
        />
      ) : null}
      {selected || creating ? (
        <VenueForm
          key={selected?.id ?? 'new'}
          organization={organization}
          selected={selected}
          onSaved={() => setRevision((v) => v + 1)}
        />
      ) : null}
    </View>
  );
}
function VenueForm({
  organization,
  selected,
  onSaved,
}: {
  organization: SellerOrganization;
  selected: SellerVenue | null;
  onSaved: () => void;
}) {
  const action = useAction(),
    [record, setRecord] = useState<z.infer<typeof venueSchema> | null>(null),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [latitude, setLatitude] = useState(''),
    [longitude, setLongitude] = useState(''),
    [tags, setTags] = useState(''),
    [age, setAge] = useState('18'),
    [address, setAddress] = useState(''),
    [contact, setContact] = useState(''),
    [schedule, setSchedule] = useState<Schedule>({ weekly: [], exceptions: [] }),
    [reason, setReason] = useState(''),
    [destinations, setDestinations] = useState<{ id: string; name: string; timezone: string }[]>([]),
    [destination, setDestination] = useState('');
  const canEdit = organization.permissions.includes('venue.edit');
  function populate(v: z.infer<typeof venueSchema>) {
    setRecord(v);
    setName(v.name);
    setDescription(v.description);
    setLatitude(v.latitude?.toString() ?? '');
    setLongitude(v.longitude?.toString() ?? '');
    setTags(v.tags.join(', '));
    setAge(String(v.minimum_age));
    setAddress(v.address);
    setContact(v.contact_url ?? '');
    setSchedule(v.schedule);
  }
  async function refresh(id = record?.id ?? selected?.id) {
    if (id)
      populate(
        z
          .object({ data: venueSchema })
          .parse(await api.request(`/v1/seller/venues/${encodeURIComponent(id)}`)).data,
      );
  }
  useEffect(() => {
    void action.run(async () => {
      if (selected) await refresh(selected.id);
      else
        setDestinations(
          z
            .object({ data: z.array(z.object({ id: z.string(), name: z.string(), timezone: z.string() })) })
            .parse(await api.request('/v1/destinations')).data,
        );
    });
  }, []);
  return (
    <View style={op.box}>
      <Text style={op.title}>{record ? `Edit ${record.name}` : 'New venue'}</Text>
      {selected && !record ? (
        <Text style={op.text}>Loading venue…</Text>
      ) : (
        <>
          {!record ? (
            <View style={op.row}>
              {destinations.map((d) => (
                <Button
                  key={d.id}
                  label={`${destination === d.id ? '✓ ' : ''}${d.name} (${d.timezone})`}
                  onPress={() => setDestination(d.id)}
                />
              ))}
            </View>
          ) : (
            <Text style={op.text}>
              {record.status} · version {record.version} · {selected?.timezone}
            </Text>
          )}
          <Field label="Venue name" value={name} onChange={setName} />
          <Field label="Description" value={description} onChange={setDescription} multiline />
          <Field label="Street address" value={address} onChange={setAddress} />
          <Field label="Latitude" value={latitude} onChange={setLatitude} />
          <Field label="Longitude" value={longitude} onChange={setLongitude} />
          <Field label="Minimum age" value={age} onChange={setAge} />
          <Field label="Tags, separated by commas" value={tags} onChange={setTags} />
          <Field label="Public HTTPS contact website (optional)" value={contact} onChange={setContact} />
          <ScheduleEditor value={schedule} onChange={setSchedule} />
          {canEdit ? (
            <Button
              label={record ? 'Save venue changes' : 'Create draft venue'}
              disabled={action.busy || (!record && !destination)}
              onPress={() =>
                void action.run(async () => {
                  if (!latitude.trim() || !longitude.trim() || !age.trim())
                    throw new Error('Enter coordinates and minimum age.');
                  const data = {
                    name,
                    description,
                    latitude: Number(latitude),
                    longitude: Number(longitude),
                    tags: splitList(tags),
                    minimumAge: Number(age),
                    address,
                    contactUrl: contact.trim() || null,
                    schedule,
                  };
                  const slug = `${
                    name
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '')
                      .slice(0, 55) || 'venue'
                  }-${Crypto.randomUUID().slice(0, 8)}`;
                  const response = z.object({ data: venueSchema }).parse(
                    await api.post(
                      record ? `/v1/seller/venues/${encodeURIComponent(record.id)}` : '/v1/seller/venues',
                      record
                        ? { ...data, expectedVersion: record.version }
                        : {
                            ...data,
                            id: slug,
                            organizationId: organization.id,
                            destinationId: destination,
                          },
                    ),
                  );
                  populate(response.data);
                  onSaved();
                  action.setMessage('Venue saved.');
                })
              }
            />
          ) : null}
          {record ? (
            <>
              <Button
                label="Reload saved venue"
                disabled={action.busy}
                onPress={() => void action.run(() => refresh())}
              />
              {canEdit ? (
                <SellerMedia
                  kind="venues"
                  id={record.id}
                  version={record.version}
                  onChanged={async () => {
                    await refresh();
                    onSaved();
                  }}
                />
              ) : null}
              {organization.permissions.includes('event.publish') ? (
                <>
                  <Field label="Publication reason" value={reason} onChange={setReason} />
                  <Button
                    label={record.status === 'published' ? 'Hide venue' : 'Publish venue'}
                    disabled={action.busy}
                    onPress={() =>
                      void action.run(async () => {
                        await api.post(`/v1/seller/venues/${encodeURIComponent(record.id)}/publication`, {
                          status: record.status === 'published' ? 'hidden' : 'published',
                          expectedVersion: record.version,
                          reason,
                        });
                        await refresh();
                        onSaved();
                      })
                    }
                  />
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

const eventSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  lineup: z.array(z.string()),
  tags: z.array(z.string()),
  external_url: z.string().nullable(),
  version: z.number(),
  status: z.string(),
  venue_id: z.string(),
  host_organization_id: z.string().nullable(),
});
export type EventDraft = {
  title: string;
  description: string;
  lineup: string[];
  tags: string[];
  externalUrl: string | null;
  occurrences: { startsAt: string; endsAt: string; capacity: number }[];
};
export const blankEvent = (): EventDraft => ({
  title: '',
  description: '',
  lineup: [],
  tags: [],
  externalUrl: null,
  occurrences: [{ startsAt: '', endsAt: '', capacity: 0 }],
});
export function EventFields({
  value,
  onChange,
  dates = true,
}: {
  value: EventDraft;
  onChange: (v: EventDraft) => void;
  dates?: boolean;
}) {
  // Preserve separators while typing while maintaining the normalized API values.
  const [lineup, setLineup] = useState(value.lineup.join(', ')),
    [tags, setTags] = useState(value.tags.join(', '));
  return (
    <View style={{ gap: 10 }}>
      <Field label="Event title" value={value.title} onChange={(title) => onChange({ ...value, title })} />
      <Field
        label="Event description"
        value={value.description}
        onChange={(description) => onChange({ ...value, description })}
        multiline
      />
      <Field
        label="Lineup, separated by commas"
        value={lineup}
        onChange={(text) => {
          setLineup(text);
          onChange({ ...value, lineup: splitList(text) });
        }}
      />
      <Field
        label="Event tags, separated by commas"
        value={tags}
        onChange={(text) => {
          setTags(text);
          onChange({ ...value, tags: splitList(text) });
        }}
      />
      <Field
        label="External ticket website (HTTPS, optional)"
        value={value.externalUrl ?? ''}
        onChange={(externalUrl) => onChange({ ...value, externalUrl: externalUrl || null })}
      />
      <Text style={op.text}>
        An external ticket website sends buyers to that seller; Clubby does not issue tickets or collect that
        payment.
      </Text>
      {dates ? (
        <>
          <Text style={op.text}>
            Enter venue-local dates with their UTC offset, for example 2026-12-31T22:00:00+01:00. Overnight
            events need the following day as their end date.
          </Text>
          {value.occurrences.map((o, index) => (
            <View key={index} style={op.box}>
              <Field
                label="Starts at"
                value={o.startsAt}
                onChange={(startsAt) =>
                  onChange({
                    ...value,
                    occurrences: value.occurrences.map((x, i) => (i === index ? { ...x, startsAt } : x)),
                  })
                }
              />
              <Field
                label="Ends at"
                value={o.endsAt}
                onChange={(endsAt) =>
                  onChange({
                    ...value,
                    occurrences: value.occurrences.map((x, i) => (i === index ? { ...x, endsAt } : x)),
                  })
                }
              />
              <Field
                label="Attendance capacity"
                value={String(o.capacity)}
                onChange={(capacity) =>
                  onChange({
                    ...value,
                    occurrences: value.occurrences.map((x, i) =>
                      i === index ? { ...x, capacity: Number(capacity) } : x,
                    ),
                  })
                }
              />
              {value.occurrences.length > 1 ? (
                <Button
                  label="Remove date"
                  onPress={() =>
                    onChange({ ...value, occurrences: value.occurrences.filter((_, i) => i !== index) })
                  }
                />
              ) : null}
            </View>
          ))}
          <Button
            label="Add another date"
            disabled={value.occurrences.length >= 100}
            onPress={() =>
              onChange({
                ...value,
                occurrences: [...value.occurrences, { startsAt: '', endsAt: '', capacity: 0 }],
              })
            }
          />
        </>
      ) : null}
    </View>
  );
}
export function SellerEvents({ organization }: { organization: SellerOrganization }) {
  const [id, setId] = useState(''),
    [creating, setCreating] = useState(false),
    [revision, setRevision] = useState(0);
  return (
    <View style={op.box}>
      <Text style={op.title}>Events</Text>
      <EventPicker
        key={revision}
        organizationId={organization.id}
        value={id}
        onChange={(e) => {
          setId(e.id);
          setCreating(false);
        }}
      />
      <Button
        label="Create an event at your venue"
        onPress={() => {
          setId('');
          setCreating(true);
        }}
      />
      {id || creating ? (
        <EventForm
          key={id || 'new'}
          organization={organization}
          id={id}
          onSaved={() => setRevision((v) => v + 1)}
        />
      ) : null}
    </View>
  );
}
function EventForm({
  organization,
  id,
  onSaved,
}: {
  organization: SellerOrganization;
  id: string;
  onSaved: () => void;
}) {
  const action = useAction(),
    [record, setRecord] = useState<z.infer<typeof eventSchema> | null>(null),
    [dates, setDates] = useState<Occurrence[]>([]),
    [value, setValue] = useState(blankEvent),
    [venue, setVenue] = useState<SellerVenue | null>(null),
    [reason, setReason] = useState(''),
    [revision, setRevision] = useState(0);
  async function load(eventId = record?.id ?? id) {
    const response = z
      .object({ data: z.object({ event: eventSchema, occurrences: z.array(occurrenceSchema) }) })
      .parse(await api.request(`/v1/seller/events/${eventId}`));
    setRecord(response.data.event);
    setDates(response.data.occurrences);
    setValue({ ...response.data.event, externalUrl: response.data.event.external_url, occurrences: [] });
    setRevision((v) => v + 1);
  }
  useEffect(() => {
    if (id) void action.run(() => load(id));
  }, [id]);
  return (
    <View style={op.box}>
      {id && !record ? (
        <Text style={op.text}>Loading event…</Text>
      ) : (
        <>
          {!record ? (
            <VenuePicker organizationId={organization.id} value={venue?.id ?? ''} onChange={setVenue} />
          ) : (
            <Text style={op.text}>
              {record.status} · version {record.version}
            </Text>
          )}
          {venue ? (
            <Text style={op.text}>
              Dates use {venue.timezone}; prices use {venue.currency}.
            </Text>
          ) : null}
          <EventFields key={revision} value={value} onChange={setValue} dates={!record} />
          <Button
            label={record ? 'Save event details' : 'Create draft event'}
            disabled={action.busy || (!record && !venue)}
            onPress={() =>
              void action.run(async () => {
                const { occurrences, ...details } = value;
                const payload = {
                  title: details.title,
                  description: details.description,
                  lineup: details.lineup,
                  tags: details.tags,
                  externalUrl: details.externalUrl,
                };
                const response = z
                  .object({ data: z.object({ id: z.string() }) })
                  .parse(
                    await api.post(
                      record ? `/v1/seller/events/${record.id}` : '/v1/seller/events',
                      record
                        ? { ...payload, expectedVersion: record.version }
                        : { ...payload, occurrences, venueId: venue!.id },
                    ),
                  );
                await load(response.data.id);
                onSaved();
                action.setMessage('Event saved.');
              })
            }
          />
          {record ? (
            <>
              <Button
                label="Reload saved event"
                disabled={action.busy}
                onPress={() => void action.run(() => load())}
              />
              <SellerMedia
                kind="events"
                id={record.id}
                version={record.version}
                onChanged={async () => {
                  await load();
                  onSaved();
                }}
              />
              {record.host_organization_id === organization.id &&
              organization.permissions.includes('event.publish') ? (
                <>
                  <Field label="Publication reason" value={reason} onChange={setReason} />
                  <Button
                    label={record.status === 'published' ? 'Hide event' : 'Publish event'}
                    disabled={action.busy}
                    onPress={() =>
                      void action.run(async () => {
                        await api.post(`/v1/seller/events/${record.id}/publication`, {
                          status: record.status === 'published' ? 'hidden' : 'published',
                          expectedVersion: record.version,
                          reason,
                        });
                        await load();
                        onSaved();
                      })
                    }
                  />
                  {dates.map((o) => (
                    <OccurrenceChange
                      key={`${o.id}:${o.version}`}
                      occurrence={o}
                      onChanged={async () => {
                        await load();
                        onSaved();
                      }}
                    />
                  ))}
                </>
              ) : (
                dates.map((o) => (
                  <Text key={o.id} style={op.text}>
                    {eventTime(o)}
                  </Text>
                ))
              )}
            </>
          ) : null}
        </>
      )}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
function OccurrenceChange({
  occurrence: o,
  onChanged,
}: {
  occurrence: Occurrence;
  onChanged: () => Promise<void>;
}) {
  const action = useAction(),
    [startsAt, setStart] = useState(zonedInput(o.starts_at, o.timezone)),
    [endsAt, setEnd] = useState(zonedInput(o.ends_at, o.timezone)),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  async function change(kind: 'cancel' | 'reschedule') {
    await api.post(`/v1/seller/occurrences/${o.id}/change`, {
      action: kind,
      expectedVersion: o.version,
      reason,
      ...(kind === 'reschedule' ? { startsAt, endsAt } : {}),
    });
    await onChanged();
  }
  return (
    <View style={op.box}>
      <Text style={op.text}>{eventTime(o)}</Text>
      {o.status !== 'cancelled' ? (
        <>
          <Field label={`New start (${o.timezone}, include offset)`} value={startsAt} onChange={setStart} />
          <Field label="New end (include offset)" value={endsAt} onChange={setEnd} />
          <Field label="Reason for changing the event date" value={reason} onChange={setReason} />
          <Toggle
            label="I understand this affects existing bookings: cancellation triggers refunds; rescheduling stops affected table sales and refunds table reservations."
            value={confirmed}
            onChange={setConfirmed}
          />
          <Button
            label="Reschedule this date"
            disabled={action.busy || !confirmed}
            onPress={() => void action.run(() => change('reschedule'))}
          />
          <Button
            label="Cancel this date"
            disabled={action.busy || !confirmed}
            onPress={() => void action.run(() => change('cancel'))}
          />
        </>
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

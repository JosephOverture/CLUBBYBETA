import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, op, useAction } from './OperationsUI';
import { PublicVenuePicker } from './PublicVenuePicker';
const claimSchema = z.object({
  id: z.string(),
  venue_id: z.string(),
  venue_name: z.string(),
  venue_version: z.number(),
  organization_name: z.string(),
  evidence: z.string(),
  status: z.string(),
});
const placementSchema = z.object({
  venue_id: z.string(),
  name: z.string(),
  status: z.string(),
  rank: z.number(),
  starts_at: z.string(),
  ends_at: z.string(),
  version: z.number(),
  active: z.boolean(),
});
export default function CatalogueAdministration() {
  const action = useAction(),
    [claims, setClaims] = useState<z.infer<typeof claimSchema>[]>([]),
    [claimCursor, setClaimCursor] = useState<string | null>(null),
    [placements, setPlacements] = useState<z.infer<typeof placementSchema>[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<{ id: string; name: string; version: number } | null>(null),
    [rank, setRank] = useState('0'),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [reason, setReason] = useState('');
  async function loadClaims(before?: string) {
    const result = z
      .object({ data: z.array(claimSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/admin/venue-claims${before ? `?before=${before}` : ''}`));
    setClaims((old) => (before ? [...old, ...result.data] : result.data));
    setClaimCursor(result.meta.nextCursor);
  }
  async function loadPlacements(before?: string) {
    const result = z
      .object({ data: z.array(placementSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(
        await api.request(`/v1/admin/editorial${before ? `?before=${encodeURIComponent(before)}` : ''}`),
      );
    setPlacements((old) => (before ? [...old, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  useEffect(() => {
    void action.run(async () => {
      await loadClaims();
      await loadPlacements();
    });
  }, []);
  return (
    <View style={{ gap: 14 }}>
      <Text style={op.title}>Venue claims</Text>
      <Field label="Reason for catalogue decision" value={reason} onChange={setReason} />
      <Button
        label="Refresh claims"
        disabled={action.busy}
        onPress={() => void action.run(() => loadClaims())}
      />
      {claims.map((c) => (
        <View key={c.id} style={op.box}>
          <Text style={op.text}>
            {c.organization_name} claims {c.venue_name}
          </Text>
          <Text style={op.text}>{c.evidence}</Text>
          <Text style={op.text}>
            Approval transfers venue management to this seller. Verify the evidence and current ownership
            before approving.
          </Text>
          <View style={op.row}>
            {(['approved', 'rejected'] as const).map((decision) => (
              <Button
                key={decision}
                label={decision === 'approved' ? 'Approve claim' : 'Reject claim'}
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await api.post(`/v1/admin/venue-claims/${c.id}/review`, {
                      decision,
                      expectedVenueVersion: c.venue_version,
                      reason,
                    });
                    await loadClaims();
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}
      {claimCursor ? (
        <Button
          label="More claims"
          disabled={action.busy}
          onPress={() => void action.run(() => loadClaims(claimCursor))}
        />
      ) : null}
      <Text style={op.title}>Featured placements</Text>
      <Button
        label="Refresh placements"
        disabled={action.busy}
        onPress={() => void action.run(() => loadPlacements())}
      />
      {placements.map((p) => (
        <View key={p.venue_id} style={op.box}>
          <Text style={op.text}>
            {p.name} · rank {p.rank} · {p.starts_at} – {p.ends_at} · {p.active ? 'enabled' : 'removed'} ·
            venue {p.status}
          </Text>
          <Button
            label={`Edit placement for ${p.name}`}
            onPress={() => {
              setSelected({ id: p.venue_id, name: p.name, version: p.version });
              setRank(String(p.rank));
              setStart(p.starts_at);
              setEnd(p.ends_at);
            }}
          />
          {p.active ? (
            <Button
              label="Remove featured placement"
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/admin/editorial/${encodeURIComponent(p.venue_id)}/remove`, {
                    expectedVersion: p.version,
                    reason,
                  });
                  setSelected(null);
                  await loadPlacements();
                })
              }
            />
          ) : null}
        </View>
      ))}
      {cursor ? (
        <Button
          label="More placements"
          disabled={action.busy}
          onPress={() => void action.run(() => loadPlacements(cursor))}
        />
      ) : null}
      <PublicVenuePicker
        value={selected?.id ?? ''}
        onChange={(v) => {
          const existing = placements.find((p) => p.venue_id === v.id);
          setSelected({ ...v, version: existing?.version ?? 0 });
          setRank(String(existing?.rank ?? 0));
          setStart(existing?.starts_at ?? '');
          setEnd(existing?.ends_at ?? '');
        }}
      />
      {selected ? (
        <>
          <Text style={op.text}>Placement for {selected.name}</Text>
          <Field label="Display rank (lower appears first)" value={rank} onChange={setRank} />
          <Field label="Featured from (date and UTC offset)" value={start} onChange={setStart} />
          <Field label="Featured until (date and UTC offset)" value={end} onChange={setEnd} />
          <Button
            label="Save featured placement"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post('/v1/admin/editorial', {
                  venueId: selected.id,
                  rank: Number(rank),
                  startsAt: start,
                  endsAt: end,
                  expectedVersion: selected.version,
                  reason,
                });
                setSelected(null);
                await loadPlacements();
              })
            }
          />
        </>
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
export function VenueClaims({ organizationId }: { organizationId: string }) {
  const action = useAction(),
    [venue, setVenue] = useState<{ id: string; name: string } | null>(null),
    [evidence, setEvidence] = useState(''),
    [claims, setClaims] = useState<{ id: string; venue_name: string; status: string }[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(before?: string) {
    const result = z
      .object({
        data: z.array(z.object({ id: z.string(), venue_name: z.string(), status: z.string() })),
        meta: z.object({ nextCursor: z.string().nullable() }),
      })
      .parse(
        await api.request(
          `/v1/organizations/${organizationId}/venue-claims${before ? `?before=${before}` : ''}`,
        ),
      );
    setClaims((old) => (before ? [...old, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  useEffect(() => {
    void action.run(() => load());
  }, [organizationId]);
  return (
    <View style={op.box}>
      <Text style={op.title}>Claim an existing venue</Text>
      <PublicVenuePicker value={venue?.id ?? ''} onChange={setVenue} />
      <Field
        label="Evidence that your organization operates this venue"
        value={evidence}
        onChange={setEvidence}
        multiline
      />
      <Button
        label="Submit claim for review"
        disabled={action.busy || !venue}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/venues/${encodeURIComponent(venue!.id)}/claims`, {
              organizationId,
              evidence,
            });
            setEvidence('');
            await load();
            action.setMessage('Claim submitted. An existing pending claim keeps its original evidence.');
          })
        }
      />
      <Button
        label="Refresh claim status"
        disabled={action.busy}
        onPress={() => void action.run(() => load())}
      />
      {claims.map((c) => (
        <Text key={c.id} style={op.text}>
          {c.venue_name} · {c.status}
        </Text>
      ))}
      {cursor ? (
        <Button
          label="More claims"
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

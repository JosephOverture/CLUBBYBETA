import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, op, useAction } from './OperationsUI';
import { VenuePicker, type SellerOrganization } from './SellerSelectors';
import { PublicVenuePicker } from './PublicVenuePicker';
import { EventFields, blankEvent, type EventDraft } from './SellerCatalogue';
const payloadSchema = z.object({
  title: z.string(),
  description: z.string(),
  lineup: z.array(z.string()),
  tags: z.array(z.string()),
  externalUrl: z.string().nullable().default(null),
  occurrences: z.array(z.object({ startsAt: z.string(), endsAt: z.string(), capacity: z.number() })),
});
const proposalSchema = z.object({
  id: z.string(),
  venue_id: z.string(),
  venue_name: z.string().optional(),
  payload: payloadSchema,
  version: z.number(),
  status: z.string(),
});
type Proposal = z.infer<typeof proposalSchema>;
export function SellerProposals({ organization }: { organization: SellerOrganization }) {
  const action = useAction(),
    [mode, setMode] = useState<'own' | 'review'>('own'),
    [venue, setVenue] = useState(''),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<Proposal | null>(null),
    [creating, setCreating] = useState(false);
  async function load(before?: string) {
    if (mode === 'review' && !venue) return;
    const path =
      mode === 'own'
        ? `/v1/organizations/${organization.id}/proposals`
        : `/v1/seller/venues/${encodeURIComponent(venue)}/proposals`;
    const response = z
      .object({ data: z.array(proposalSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`${path}${before ? `?before=${before}` : ''}`));
    setProposals((old) => (before ? [...old, ...response.data] : response.data));
    setCursor(response.meta.nextCursor);
  }
  useEffect(() => {
    setSelected(null);
    setCreating(false);
    setProposals([]);
    setCursor(null);
    void action.run(() => load());
  }, [mode, venue, organization.id]);
  return (
    <View style={op.box}>
      <Text style={op.title}>Event proposals</Text>
      <View style={op.row}>
        <Button label="Our submitted proposals" onPress={() => setMode('own')} />
        {organization.permissions.includes('event.publish') ? (
          <Button label="Review proposals at our venues" onPress={() => setMode('review')} />
        ) : null}
      </View>
      {mode === 'review' ? (
        <VenuePicker organizationId={organization.id} value={venue} onChange={(v) => setVenue(v.id)} />
      ) : organization.venueIds === null ? (
        <Button
          label="Propose an event to a venue"
          onPress={() => {
            setCreating(true);
            setSelected(null);
          }}
        />
      ) : null}
      <Button
        label="Refresh proposals"
        disabled={action.busy}
        onPress={() => void action.run(() => load())}
      />
      {proposals.map((p) => (
        <Button
          key={p.id}
          label={`${p.payload.title} · ${p.venue_name ?? 'Selected venue'} · ${p.status}`}
          onPress={() => {
            setSelected(p);
            setCreating(false);
          }}
        />
      ))}
      {cursor ? (
        <Button
          label="More proposals"
          disabled={action.busy}
          onPress={() => void action.run(() => load(cursor))}
        />
      ) : null}
      {selected || creating ? (
        <ProposalForm
          key={selected ? `${selected.id}:${selected.version}` : 'new'}
          organizationId={organization.id}
          proposal={selected}
          mode={mode}
          onChanged={async () => {
            setSelected(null);
            setCreating(false);
            await load();
          }}
        />
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
function ProposalForm({
  organizationId,
  proposal,
  mode,
  onChanged,
}: {
  organizationId: string;
  proposal: Proposal | null;
  mode: string;
  onChanged: () => Promise<void>;
}) {
  const action = useAction(),
    [value, setValue] = useState<EventDraft>(proposal?.payload ?? blankEvent()),
    [venue, setVenue] = useState<{ id: string; name: string; timezone: string } | null>(null),
    [reason, setReason] = useState(''),
    [history, setHistory] = useState<{ version: number; decision: string; comment: string }[]>([]);
  useEffect(() => {
    if (proposal)
      void action.run(async () => {
        setHistory(
          z
            .object({
              data: z.array(z.object({ version: z.number(), decision: z.string(), comment: z.string() })),
            })
            .parse(await api.request(`/v1/seller/proposals/${proposal.id}/history`)).data,
        );
      });
  }, [proposal?.id]);
  const editable =
    mode === 'own' && (!proposal || ['changes-requested', 'rejected'].includes(proposal.status));
  return (
    <View style={op.box}>
      {!proposal ? <PublicVenuePicker value={venue?.id ?? ''} onChange={setVenue} /> : null}
      {venue ? (
        <Text style={op.text}>
          {venue.name} · {venue.timezone}
        </Text>
      ) : null}
      {editable ? (
        <EventFields value={value} onChange={setValue} />
      ) : (
        <>
          <Text style={op.title}>{value.title}</Text>
          <Text style={op.text}>{value.description}</Text>
          <Text style={op.text}>
            Lineup: {value.lineup.join(', ')}. Tags: {value.tags.join(', ')}. External booking:{' '}
            {value.externalUrl ?? 'None'}.
          </Text>
          {value.occurrences.map((o, index) => (
            <Text key={index} style={op.text}>
              {o.startsAt} – {o.endsAt} · capacity {o.capacity}
            </Text>
          ))}
        </>
      )}
      {editable ? (
        <Button
          label={proposal ? 'Submit revised proposal' : 'Submit proposal for venue review'}
          disabled={action.busy || (!proposal && !venue)}
          onPress={() =>
            void action.run(async () => {
              await api.post(
                proposal ? `/v1/seller/proposals/${proposal.id}/resubmit` : '/v1/seller/proposals',
                proposal
                  ? { expectedVersion: proposal.version, event: value }
                  : { organizationId, venueId: venue!.id, event: value },
              );
              await onChanged();
            })
          }
        />
      ) : null}
      {mode === 'review' && proposal?.status === 'submitted' ? (
        <>
          <Field label="Review explanation" value={reason} onChange={setReason} />
          <Text style={op.text}>
            Approval publishes this event under the proposing organization. That organization remains the
            seller.
          </Text>
          <View style={op.row}>
            {(['approved', 'changes-requested', 'rejected'] as const).map((decision) => (
              <Button
                key={decision}
                label={
                  decision === 'approved'
                    ? 'Approve and publish'
                    : decision === 'changes-requested'
                      ? 'Request changes'
                      : 'Reject proposal'
                }
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await api.post(`/v1/seller/proposals/${proposal.id}/review`, {
                      decision,
                      expectedVersion: proposal.version,
                      reason,
                    });
                    await onChanged();
                  })
                }
              />
            ))}
          </View>
        </>
      ) : null}
      {history.map((h) => (
        <Text key={h.version} style={op.text}>
          Revision {h.version} · {h.decision}: {h.comment}
        </Text>
      ))}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

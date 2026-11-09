import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, Toggle, op, useAction } from './OperationsUI';
import type { Access } from './Support';
import { OccurrencePicker, decimalMinor } from './SellerSelectors';
import { SellerEvents, SellerVenues } from './SellerCatalogue';
import { SellerInventory } from './SellerInventory';
import { SellerLayouts } from './SellerTables';
import { SellerProposals } from './SellerProposals';
import { VenueClaims } from './CatalogueAdministration';
const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  venue_ids: z.array(z.string()).nullable(),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
const memberSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  role: z.string(),
  status: z.string(),
  venue_ids: z.array(z.string()).nullable(),
  displayName: z.string(),
  email: z.string().nullable(),
});
const commerceSchema = z.object({
  data: z.object({
    account: z
      .object({
        status: z.string(),
        charges_enabled: z.boolean(),
        payouts_enabled: z.boolean(),
        synced_at: z.string().nullable(),
        requirements: z.unknown(),
      })
      .nullable(),
    policy: z
      .object({
        id: z.string(),
        version: z.number(),
        commission_bps: z.number(),
        refund_cutoff_hours: z.number(),
        refund_commission: z.boolean(),
        terms: z.string(),
        tax_registration: z.string(),
        accepted_at: z.string().nullable(),
      })
      .nullable(),
  }),
});
const promotionSchema = z.object({
  id: z.string(),
  code: z.string(),
  discount_bps: z.number(),
  max_uses: z.number(),
  committed_uses: z.number(),
  active: z.boolean(),
  version: z.number(),
  expires_at: z.string(),
});
export default function SellerAccount({
  access,
  onChanged,
}: {
  access: Access | null;
  onChanged: () => Promise<void>;
}) {
  const action = useAction(),
    [name, setName] = useState(''),
    [legalName, setLegalName] = useState(''),
    [country, setCountry] = useState('IT'),
    [token, setToken] = useState(''),
    [selected, setSelected] = useState(''),
    [section, setSection] = useState('account');
  const org = access?.organizations.find((o) => o.id === selected);
  useEffect(() => {
    if (!access?.organizations.some((o) => o.id === selected))
      setSelected(access?.organizations[0]?.id ?? '');
  }, [access]);
  return (
    <View style={op.box}>
      <Text style={op.title}>Seller account</Text>
      <Text style={op.text}>
        Apply as a venue or organizer. Clubby reviews the application before seller tools become available.
      </Text>
      <Field label="Business display name" value={name} onChange={setName} />
      <Field label="Legal business name" value={legalName} onChange={setLegalName} />
      <Field label="Country code (for example IT)" value={country} onChange={setCountry} />
      <Button
        label="Submit seller application"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post('/v1/organizations', { name, legalName, countryCode: country.toUpperCase() });
            setName('');
            setLegalName('');
            await onChanged();
            action.setMessage('Application submitted for review.');
          })
        }
      />
      <Field label="Staff invitation code from your email" value={token} onChange={setToken} />
      <Button
        label="Accept staff invitation"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post('/v1/invitations/accept', { token: token.trim() });
            setToken('');
            await onChanged();
          })
        }
      />
      <View style={op.row}>
        {access?.organizations.map((o) => (
          <Button
            key={o.id}
            label={`${o.name} · ${o.role} · ${o.status}`}
            onPress={() => {
              setSelected(o.id);
              setSection('account');
            }}
          />
        ))}
      </View>
      {org ? (
        <>
          <Text style={op.text}>
            {org.name}: {org.status}. Your role is {org.role}.
          </Text>
          <View style={op.row}>
            <Button label="Account" onPress={() => setSection('account')} />
            {org.permissions.includes('venue.read') ? (
              <Button label="Venues" onPress={() => setSection('venues')} />
            ) : null}
            {org.permissions.includes('event.edit') ? (
              <>
                <Button label="Events" onPress={() => setSection('events')} />
                <Button label="Inventory" onPress={() => setSection('inventory')} />
                <Button label="Proposals" onPress={() => setSection('proposals')} />
              </>
            ) : null}
            {org.permissions.includes('venue.edit') ? (
              <Button label="Floor plans" onPress={() => setSection('layouts')} />
            ) : null}
          </View>
          {section === 'venues' && org.permissions.includes('venue.read') ? (
            <SellerVenues key={org.id} organization={org} />
          ) : null}
          {section === 'events' && org.permissions.includes('event.edit') ? (
            <SellerEvents key={org.id} organization={org} />
          ) : null}
          {section === 'inventory' && org.permissions.includes('event.edit') ? (
            <SellerInventory key={org.id} organization={org} />
          ) : null}
          {section === 'layouts' && org.permissions.includes('venue.edit') ? (
            <SellerLayouts key={org.id} organization={org} />
          ) : null}
          {section === 'proposals' && org.permissions.includes('event.edit') ? (
            <SellerProposals key={org.id} organization={org} />
          ) : null}
          {section === 'account' && org.permissions.includes('members.manage') ? (
            <OwnerAccount key={org.id} organizationId={org.id} onChanged={onChanged} />
          ) : null}
        </>
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
function OwnerAccount({
  organizationId: id,
  onChanged,
}: {
  organizationId: string;
  onChanged: () => Promise<void>;
}) {
  const action = useAction(),
    [commerce, setCommerce] = useState<z.infer<typeof commerceSchema>['data'] | null>(null),
    [accepted, setAccepted] = useState(false),
    [members, setMembers] = useState<z.infer<typeof memberSchema>[]>([]),
    [memberCursor, setMemberCursor] = useState<string | null>(null),
    [invitations, setInvitations] = useState<z.infer<typeof invitationSchema>[]>([]),
    [inviteCursor, setInviteCursor] = useState<string | null>(null),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('door'),
    [venueIds, setVenueIds] = useState<string[]>([]),
    [venues, setVenues] = useState<{ id: string; name: string }[]>([]),
    [venuesCursor, setVenuesCursor] = useState<string | null>(null),
    [restricted, setRestricted] = useState(false),
    [reason, setReason] = useState(''),
    [promotions, setPromotions] = useState<z.infer<typeof promotionSchema>[]>([]),
    [promotionCursor, setPromotionCursor] = useState<string | null>(null),
    [code, setCode] = useState(''),
    [discount, setDiscount] = useState('10'),
    [uses, setUses] = useState('100'),
    [expiry, setExpiry] = useState(''),
    [occurrence, setOccurrence] = useState('');
  async function status() {
    setCommerce(commerceSchema.parse(await api.request(`/v1/organizations/${id}/commerce`)).data);
    setAccepted(false);
  }
  async function loadStaff(before?: string) {
    if (!before) await loadMembers();
    const result = z
      .object({ data: z.array(invitationSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/organizations/${id}/invitations${before ? `?before=${before}` : ''}`));
    setInvitations((previous) => (before ? [...previous, ...result.data] : result.data));
    setInviteCursor(result.meta.nextCursor);
  }
  async function loadMembers(before?: string) {
    const result = z
      .object({ data: z.array(memberSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/organizations/${id}/members${before ? `?before=${before}` : ''}`));
    setMembers((previous) => (before ? [...previous, ...result.data] : result.data));
    setMemberCursor(result.meta.nextCursor);
  }
  async function loadVenues(before?: string) {
    const result = z
      .object({
        data: z.array(z.object({ id: z.string(), name: z.string() })),
        meta: z.object({ nextCursor: z.string().nullable() }),
      })
      .parse(
        await api.request(
          `/v1/organizations/${id}/venues${before ? `?before=${encodeURIComponent(before)}` : ''}`,
        ),
      );
    setVenues((previous) => (before ? [...previous, ...result.data] : result.data));
    setVenuesCursor(result.meta.nextCursor);
  }
  async function loadPromotions(before?: string) {
    const result = z
      .object({ data: z.array(promotionSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/organizations/${id}/promotions${before ? `?before=${before}` : ''}`));
    setPromotions((previous) => (before ? [...previous, ...result.data] : result.data));
    setPromotionCursor(result.meta.nextCursor);
  }
  useEffect(() => {
    void action.run(async () => {
      await status();
      await loadStaff();
      await loadVenues();
      await loadPromotions();
    });
  }, [id]);
  return (
    <View style={{ gap: 16 }}>
      <VenueClaims organizationId={id} />
      <Text style={op.title}>Payments and commercial terms</Text>
      <Button label="Refresh seller status" onPress={() => void action.run(status)} disabled={action.busy} />
      {commerce?.account ? (
        <Text style={op.text}>
          Payment account: {commerce.account.status}. Charges{' '}
          {commerce.account.charges_enabled ? 'enabled' : 'disabled'}; payouts{' '}
          {commerce.account.payouts_enabled ? 'enabled' : 'disabled'}. Last checked{' '}
          {commerce.account.synced_at ? new Date(commerce.account.synced_at).toLocaleString() : 'not yet'}.
          Complete any outstanding requirements in Stripe.
        </Text>
      ) : (
        <Text style={op.text}>Connect your Stripe account to receive direct payments from customers.</Text>
      )}
      <Button
        label="Open Stripe onboarding"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            const result = z
              .object({ data: z.object({ url: z.string().url() }) })
              .parse(await api.post(`/v1/organizations/${id}/connect`, {}));
            await Linking.openURL(result.data.url);
          })
        }
      />
      <Button
        label="Check Stripe requirements again"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/organizations/${id}/connect/refresh`, {});
            await status();
          })
        }
      />
      {commerce?.policy ? (
        <>
          <Text style={op.text}>
            Terms version {commerce.policy.version}. Clubby commission: {commerce.policy.commission_bps / 100}
            %. Refund cutoff: {commerce.policy.refund_cutoff_hours} hours before the event. Commission{' '}
            {commerce.policy.refund_commission ? 'is' : 'is not'} returned on eligible refunds.
          </Text>
          <Text style={op.text}>{commerce.policy.terms}</Text>
          <Text style={op.text}>Tax registration: {commerce.policy.tax_registration}</Text>
          {commerce.policy.accepted_at ? (
            <Text style={op.text}>Accepted {new Date(commerce.policy.accepted_at).toLocaleString()}</Text>
          ) : (
            <>
              <Toggle
                label="I accept these commercial terms on behalf of this seller"
                value={accepted}
                onChange={setAccepted}
              />
              <Button
                label="Accept displayed terms"
                disabled={action.busy || !accepted}
                onPress={() =>
                  void action.run(async () => {
                    await api.post(`/v1/organizations/${id}/policy/${commerce.policy!.id}/accept`, {});
                    await status();
                  })
                }
              />
            </>
          )}
        </>
      ) : (
        <Text style={op.text}>Commercial terms are awaiting platform review.</Text>
      )}
      <Text style={op.title}>Staff access</Text>
      <Text style={op.text}>
        Owners administer membership. Managers manage bookings and events, editors manage content, door staff
        admit guests and collect balances, and finance staff view reports.
      </Text>
      <Field label="Invitee email" value={email} onChange={setEmail} />
      <View style={op.row}>
        {['manager', 'editor', 'door', 'finance'].map((r) => (
          <Button key={r} label={`${role === r ? '✓ ' : ''}${r}`} onPress={() => setRole(r)} />
        ))}
      </View>
      <Toggle
        label="Restrict this invitation to selected venues"
        value={restricted}
        onChange={setRestricted}
      />
      {restricted ? (
        <>
          {venues.map((v) => (
            <Toggle
              key={v.id}
              label={v.name}
              value={venueIds.includes(v.id)}
              onChange={(checked) =>
                setVenueIds((previous) =>
                  checked ? [...previous, v.id] : previous.filter((x) => x !== v.id),
                )
              }
            />
          ))}
          {venuesCursor ? (
            <Button
              label="Load more venues"
              onPress={() => void action.run(() => loadVenues(venuesCursor))}
            />
          ) : null}
        </>
      ) : null}
      <Button
        label="Send staff invitation"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/organizations/${id}/invitations`, {
              email: email.trim(),
              role,
              venueIds: restricted ? venueIds : null,
            });
            setEmail('');
            await loadStaff();
          })
        }
      />
      <Field label="Reason for revocation or promotion changes" value={reason} onChange={setReason} />
      <Button
        label="Refresh staff"
        disabled={action.busy}
        onPress={() => void action.run(() => loadStaff())}
      />
      {members.map((m) => (
        <View key={m.id}>
          <Text style={op.text}>
            {m.displayName || m.email || 'Deleted account'} · {m.role} · {m.status} ·{' '}
            {m.venue_ids
              ?.map((venueId) => venues.find((v) => v.id === venueId)?.name ?? venueId)
              .join(', ') ?? 'All seller venues'}
          </Text>
          {m.status === 'active' && m.role !== 'owner' ? (
            <Button
              label="Revoke membership"
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/organizations/${id}/members/${m.id}/revoke`, { reason });
                  await loadStaff();
                  await onChanged();
                })
              }
            />
          ) : null}
        </View>
      ))}
      {memberCursor ? (
        <Button
          label="Load more members"
          disabled={action.busy}
          onPress={() => void action.run(() => loadMembers(memberCursor))}
        />
      ) : null}
      {invitations.map((i) => (
        <View key={i.id}>
          <Text style={op.text}>
            {i.email} · {i.role} ·{' '}
            {i.accepted_at
              ? 'accepted'
              : i.revoked_at
                ? 'revoked'
                : Date.parse(i.expires_at) < Date.now()
                  ? 'expired'
                  : 'pending'}
          </Text>
          {!i.accepted_at && !i.revoked_at && Date.parse(i.expires_at) > Date.now() ? (
            <Button
              label="Revoke invitation"
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/organizations/${id}/invitations/${i.id}/revoke`, { reason });
                  await loadStaff();
                })
              }
            />
          ) : null}
        </View>
      ))}
      {inviteCursor ? (
        <Button
          label="Load more invitations"
          disabled={action.busy}
          onPress={() => void action.run(() => loadStaff(inviteCursor))}
        />
      ) : null}
      <Text style={op.title}>Promotion codes</Text>
      <Field label="New promotion code" value={code} onChange={setCode} />
      <Field label="Discount (%)" value={discount} onChange={setDiscount} />
      <Field label="Maximum uses" value={uses} onChange={setUses} />
      <Field
        label="Expiry with UTC offset (for example 2026-12-31T23:59:00+01:00)"
        value={expiry}
        onChange={setExpiry}
      />
      <OccurrencePicker
        organizationId={id}
        value={occurrence}
        optional
        ownedOnly
        onChange={(value) => setOccurrence(value?.id ?? '')}
      />
      <Button
        label="Create promotion"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/organizations/${id}/promotions`, {
              code,
              discountBps: decimalMinor(discount),
              maxUses: Number(uses),
              expiresAt: expiry,
              ...(occurrence ? { occurrenceId: occurrence } : {}),
            });
            setCode('');
            await loadPromotions();
          })
        }
      />
      {promotions.map((p) => (
        <View key={p.id}>
          <Text style={op.text}>
            {p.code}: {p.discount_bps / 100}% · {p.committed_uses}/{p.max_uses} reserved or used · expires{' '}
            {new Date(p.expires_at).toLocaleString()} · {p.active ? 'active' : 'paused'}
          </Text>
          <Button
            label={p.active ? 'Pause promotion' : 'Enable promotion'}
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/organizations/${id}/promotions/${p.id}/status`, {
                  active: !p.active,
                  expectedVersion: p.version,
                  reason,
                });
                await loadPromotions();
              })
            }
          />
        </View>
      ))}
      {promotionCursor ? (
        <Button
          label="Load more promotions"
          disabled={action.busy}
          onPress={() => void action.run(() => loadPromotions(promotionCursor))}
        />
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

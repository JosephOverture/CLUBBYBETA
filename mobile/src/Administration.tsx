import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, Toggle, op, useAction } from './OperationsUI';
import CatalogueAdministration from './CatalogueAdministration';
import Operations from './Operations';
const user = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  status: z.string(),
  version: z.number(),
});
const grant = z.object({ role: z.string(), version: z.number(), revokedAt: z.string().nullable() });
const market = z.object({
  id: z.string(),
  name: z.string(),
  country_code: z.string(),
  currency: z.string(),
  timezone: z.string(),
  version: z.number(),
  published: z.boolean(),
  native_sales_enabled: z.boolean(),
  expires_at: z.string().nullable(),
  evidence: z.string().nullable(),
  seller_countries: z.array(z.string()).nullable(),
});
const checks = {
  catalogueReviewed: 'Catalogue and event information reviewed',
  providerSupported: 'Payment provider supports this market',
  refundAndTaxTermsReviewed: 'Refund and tax terms reviewed',
  payoutsReviewed: 'Seller payouts reviewed',
  localSupportReady: 'Local customer support ready',
  privacyReviewed: 'Privacy and retention reviewed',
};
const featureLabels = {
  groupCreation: 'New groups',
  ticketTransfers: 'New ticket transfers',
  walletCreation: 'New wallet passes',
  chatMessages: 'New chat messages',
};
const features = z.object({
  groupCreation: z.boolean(),
  ticketTransfers: z.boolean(),
  walletCreation: z.boolean(),
  chatMessages: z.boolean(),
});
const settingsSchema = z.object({
  banner: z.string(),
  newSalesPaused: z.boolean(),
  features,
  version: z.number(),
});
const organization = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number(),
  country_code: z.string(),
  application: z.object({ legalName: z.string().optional() }).passthrough(),
});
const organizationDetail = organization.extend({
  members: z.array(
    z.object({
      id: z.string(),
      user_id: z.string(),
      role: z.string(),
      status: z.string(),
      email: z.string().nullable(),
    }),
  ),
  venues: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      version: z.number(),
      commercial_mode: z.string(),
      external_url: z.string().nullable(),
    }),
  ),
  ownershipRequests: z.array(
    z.object({ id: z.string(), from_user_id: z.string(), to_user_id: z.string(), expires_at: z.string() }),
  ),
  policy: z
    .object({
      terms: z.string(),
      commission_bps: z.number(),
      refund_cutoff_hours: z.number(),
      refund_commission: z.boolean(),
      tax_registration: z.string(),
      version: z.number(),
    })
    .nullable(),
});
export default function Administration({ onChanged }: { onChanged: () => Promise<void> }) {
  const [tab, setTab] = useState('Sellers');
  return (
    <View style={op.box}>
      <Text style={op.title}>Administration</Text>
      <Text style={op.text}>
        Sensitive changes require a recent sign-in. If your session is too old, sign in again before
        submitting.
      </Text>
      <View style={op.row}>
        {['Sellers', 'Users', 'Markets', 'Catalogue', 'Operations', 'Service controls', 'Audit'].map((v) => (
          <Button key={v} label={`${tab === v ? '● ' : ''}${v}`} onPress={() => setTab(v)} />
        ))}
      </View>
      {tab === 'Operations' ? (
        <Operations />
      ) : tab === 'Catalogue' ? (
        <CatalogueAdministration />
      ) : tab === 'Users' ? (
        <Users onChanged={onChanged} />
      ) : tab === 'Markets' ? (
        <Markets />
      ) : tab === 'Service controls' ? (
        <Settings />
      ) : tab === 'Audit' ? (
        <Audit />
      ) : (
        <Sellers />
      )}
    </View>
  );
}
function Users({ onChanged }: { onChanged: () => Promise<void> }) {
  const action = useAction(),
    [query, setQuery] = useState(''),
    [person, setPerson] = useState<z.infer<typeof user> | null>(null),
    [grants, setGrants] = useState<z.infer<typeof grant>[]>([]),
    [reason, setReason] = useState('');
  async function load() {
    const rows = z
      .object({ data: z.array(user) })
      .parse(await api.request(`/v1/admin/users?query=${encodeURIComponent(query.trim())}`)).data;
    setPerson(rows[0] ?? null);
    setGrants([]);
    if (rows[0])
      setGrants(
        z.object({ data: z.array(grant) }).parse(await api.request(`/v1/admin/users/${rows[0].id}/grants`))
          .data,
      );
    else action.setMessage('No account found.');
  }
  return (
    <View style={op.box}>
      <Field label="Exact account email or account ID" value={query} onChange={setQuery} />
      <Button label="Find account" disabled={action.busy} onPress={() => void action.run(load)} />
      {person ? (
        <>
          <Text style={op.text}>
            {person.displayName || person.email} · {person.status}
          </Text>
          <Text selectable style={op.text}>
            {person.id}
          </Text>
          <Field label="Reason for account or access change" value={reason} onChange={setReason} multiline />
          {['active', 'suspended'].includes(person.status) ? (
            <Button
              label={
                person.status === 'active' ? 'Suspend account and revoke sessions' : 'Reactivate account'
              }
              disabled={action.busy || reason.trim().length < 10}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/admin/users/${person.id}/status`, {
                    status: person.status === 'active' ? 'suspended' : 'active',
                    expectedVersion: person.version,
                    reason,
                  });
                  await load();
                  await onChanged();
                })
              }
            />
          ) : null}
          {person.status === 'active'
            ? ['admin', 'support', 'finance'].map((role) => {
                const current = grants.find((g) => g.role === role),
                  active = Boolean(current && !current.revokedAt);
                return (
                  <Button
                    key={role}
                    label={`${active ? 'Revoke' : 'Grant'} platform ${role}`}
                    disabled={action.busy || reason.trim().length < 10}
                    onPress={() =>
                      void action.run(async () => {
                        await api.post(`/v1/admin/users/${person.id}/grants`, {
                          role,
                          active: !active,
                          expectedVersion: current?.version ?? 0,
                          reason,
                        });
                        await load();
                        await onChanged();
                      })
                    }
                  />
                );
              })
            : null}
        </>
      ) : null}
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Settings() {
  const action = useAction(),
    [settings, setSettings] = useState<z.infer<typeof settingsSchema> | null>(null),
    [reason, setReason] = useState('');
  async function load() {
    setSettings(z.object({ settings: settingsSchema }).parse(await api.request('/v1/bootstrap')).settings);
  }
  useEffect(() => {
    void action.run(load);
  }, []);
  return (
    <View style={op.box}>
      {settings ? (
        <>
          <Field
            label="Public service banner"
            value={settings.banner}
            onChange={(banner) => setSettings({ ...settings, banner })}
            multiline
          />
          <Toggle
            label="Pause all new sales"
            value={settings.newSalesPaused}
            onChange={(newSalesPaused) => setSettings({ ...settings, newSalesPaused })}
          />
          {(Object.keys(featureLabels) as (keyof typeof featureLabels)[]).map((key) => (
            <Toggle
              key={key}
              label={featureLabels[key]}
              value={settings.features[key]}
              onChange={(value) =>
                setSettings({ ...settings, features: { ...settings.features, [key]: value } })
              }
            />
          ))}
          <Field label="Reason for service changes" value={reason} onChange={setReason} multiline />
          <Button
            label="Save service controls"
            disabled={action.busy || reason.trim().length < 5}
            onPress={() =>
              void action.run(async () => {
                await api.post('/v1/admin/settings', {
                  ...settings,
                  version: undefined,
                  expectedVersion: settings.version,
                  reason,
                });
                await load();
                action.setMessage('Service controls saved.');
              })
            }
          />
        </>
      ) : null}
      <Button label="Reload current settings" disabled={action.busy} onPress={() => void action.run(load)} />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Markets() {
  const action = useAction(),
    [rows, setRows] = useState<z.infer<typeof market>[]>([]),
    [selected, setSelected] = useState('');
  async function load() {
    setRows(z.object({ data: z.array(market) }).parse(await api.request('/v1/admin/markets')).data);
  }
  useEffect(() => {
    void action.run(load);
  }, []);
  const current = rows.find((r) => r.id === selected);
  return (
    <View style={op.box}>
      <View style={op.row}>
        {rows.map((row) => (
          <Button key={row.id} label={row.name} onPress={() => setSelected(row.id)} />
        ))}
      </View>
      {current ? <Market key={`${current.id}:${current.version}`} value={current} reload={load} /> : null}
      <Destination reload={load} />
      <Button label="Refresh markets" disabled={action.busy} onPress={() => void action.run(load)} />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Market({ value: m, reload }: { value: z.infer<typeof market>; reload: () => Promise<void> }) {
  const action = useAction(),
    [reason, setReason] = useState(''),
    [evidence, setEvidence] = useState(''),
    [countries, setCountries] = useState(m.seller_countries?.join(', ') ?? m.country_code),
    [expires, setExpires] = useState(''),
    [review, setReview] = useState<Record<string, boolean>>({});
  return (
    <View style={op.box}>
      <Text style={op.title}>{m.name}</Text>
      <Text style={op.text}>
        {m.currency} · {m.timezone} · {m.published ? 'Published' : 'Hidden'} · Sales{' '}
        {m.native_sales_enabled ? 'enabled' : 'disabled'}
      </Text>
      {m.expires_at ? (
        <Text style={op.text}>
          Review expires: {new Date(m.expires_at).toLocaleString()}
          {'\n'}
          {m.evidence}
        </Text>
      ) : (
        <Text style={op.text}>No commercial review recorded.</Text>
      )}
      <Field label="Reason for market action" value={reason} onChange={setReason} multiline />
      <View style={op.row}>
        <Button
          label={m.published ? 'Hide destination' : 'Publish destination'}
          disabled={action.busy || reason.length < 10}
          onPress={() =>
            void action.run(async () => {
              await api.post(`/v1/admin/destinations/${m.id}/visibility`, {
                published: !m.published,
                expectedVersion: m.version,
                reason,
              });
              await reload();
            })
          }
        />
        <Button
          label={m.native_sales_enabled ? 'Disable market sales' : 'Enable reviewed market sales'}
          disabled={action.busy || reason.length < 10}
          onPress={() =>
            void action.run(async () => {
              await api.post(`/v1/admin/destinations/${m.id}/commerce`, {
                enabled: !m.native_sales_enabled,
                expectedVersion: m.version,
                reason,
              });
              await reload();
            })
          }
        />
      </View>
      <Text style={op.title}>Record a new market review</Text>
      <Text style={op.text}>
        Record the evidence for each check. Saving a new review disables sales until the reviewed market is
        enabled again.
      </Text>
      {Object.entries(checks).map(([key, label]) => (
        <Toggle
          key={key}
          label={label}
          value={Boolean(review[key])}
          onChange={(value) => setReview({ ...review, [key]: value })}
        />
      ))}
      <Field
        label="Approved seller countries (ISO codes, comma separated)"
        value={countries}
        onChange={setCountries}
      />
      <Field label="Review expiry (ISO date and time with timezone)" value={expires} onChange={setExpires} />
      <Field
        label="Review evidence and document references"
        value={evidence}
        onChange={setEvidence}
        multiline
      />
      <Button
        label="Record completed review"
        disabled={
          action.busy ||
          !Object.keys(checks).every((k) => review[k]) ||
          evidence.trim().length < 40 ||
          reason.trim().length < 10
        }
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/admin/destinations/${m.id}/market-review`, {
              expectedVersion: m.version,
              sellerCountries: countries
                .split(',')
                .map((c) => c.trim().toUpperCase())
                .filter(Boolean),
              checks: review,
              evidence,
              expiresAt: expires.trim(),
              reason,
            });
            await reload();
          })
        }
      />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Destination({ reload }: { reload: () => Promise<void> }) {
  const action = useAction(),
    [open, setOpen] = useState(false),
    [form, setForm] = useState({
      id: '',
      name: '',
      countryCode: '',
      timezone: '',
      currency: 'EUR',
      aliases: '',
      reason: '',
    });
  return (
    <View style={op.box}>
      <Button label="Add destination" onPress={() => setOpen(!open)} />
      {open ? (
        <>
          {Object.entries({
            id: 'Destination slug',
            name: 'Destination name',
            countryCode: 'Country ISO code',
            timezone: 'IANA timezone',
            currency: 'Currency code',
            aliases: 'Aliases (comma separated)',
            reason: 'Reason',
          }).map(([key, label]) => (
            <Field
              key={key}
              label={label}
              value={form[key as keyof typeof form]}
              onChange={(v) => setForm({ ...form, [key]: v })}
            />
          ))}
          <Button
            label="Create hidden destination"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post('/v1/admin/destinations', {
                  ...form,
                  aliases: form.aliases
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                  published: false,
                });
                setOpen(false);
                await reload();
              })
            }
          />
        </>
      ) : null}
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Sellers() {
  const action = useAction(),
    [rows, setRows] = useState<z.infer<typeof organization>[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<z.infer<typeof organizationDetail> | null>(null);
  async function load(more = false) {
    const result = z
      .object({ data: z.array(organization), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/admin/organizations${more && cursor ? `?before=${cursor}` : ''}`));
    setRows((previous) => (more ? [...previous, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  async function open(id: string) {
    setDetail(
      z.object({ data: organizationDetail }).parse(await api.request(`/v1/admin/organizations/${id}`)).data,
    );
  }
  useEffect(() => {
    void action.run(() => load());
  }, []);
  return (
    <View style={op.box}>
      {rows.map((row) => (
        <Button
          key={row.id}
          label={`${row.name} · ${row.status}`}
          disabled={action.busy}
          onPress={() => void action.run(() => open(row.id))}
        />
      ))}
      {cursor ? (
        <Button
          label="Load more sellers"
          disabled={action.busy}
          onPress={() => void action.run(() => load(true))}
        />
      ) : null}
      {detail ? (
        <Seller
          key={`${detail.id}:${detail.version}`}
          value={detail}
          reload={async () => {
            await open(detail.id);
            await load();
          }}
        />
      ) : null}
      <Button label="Refresh sellers" disabled={action.busy} onPress={() => void action.run(() => load())} />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Seller({
  value: org,
  reload,
}: {
  value: z.infer<typeof organizationDetail>;
  reload: () => Promise<void>;
}) {
  const action = useAction(),
    [reason, setReason] = useState(''),
    [incoming, setIncoming] = useState(''),
    [outgoing, setOutgoing] = useState(''),
    [policy, setPolicy] = useState({
      commission: String((org.policy?.commission_bps ?? 0) / 100),
      cutoff: String(org.policy?.refund_cutoff_hours ?? 0),
      tax: org.policy?.tax_registration ?? '',
      terms: org.policy?.terms ?? '',
      refundCommission: org.policy?.refund_commission ?? true,
    });
  return (
    <View style={op.box}>
      <Text style={op.title}>{org.name}</Text>
      <Text style={op.text}>
        {org.application.legalName ?? org.name} · {org.country_code} · {org.status}
      </Text>
      <Field label="Reason for seller action" value={reason} onChange={setReason} multiline />
      <View style={op.row}>
        {['approved', 'rejected', 'suspended'].map((status) => (
          <Button
            key={status}
            label={`Set ${status}`}
            disabled={action.busy || reason.length < 10 || org.status === status}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/admin/organizations/${org.id}/review`, {
                  status,
                  expectedVersion: org.version,
                  reason,
                });
                await reload();
              })
            }
          />
        ))}
      </View>
      <Text style={op.title}>Commercial policy</Text>
      <Text style={op.text}>
        Processing fees are paid by the seller. Stripe manages seller payouts. The owner must accept each new
        version.
      </Text>
      <Field
        label="Commission percentage"
        value={policy.commission}
        onChange={(commission) => setPolicy({ ...policy, commission })}
      />
      <Field
        label="Refund cutoff hours before event"
        value={policy.cutoff}
        onChange={(cutoff) => setPolicy({ ...policy, cutoff })}
      />
      <Field
        label="Seller tax registration"
        value={policy.tax}
        onChange={(tax) => setPolicy({ ...policy, tax })}
      />
      <Field
        label="Complete commercial terms"
        value={policy.terms}
        onChange={(terms) => setPolicy({ ...policy, terms })}
        multiline
      />
      <Toggle
        label="Return commission on refunds"
        value={policy.refundCommission}
        onChange={(refundCommission) => setPolicy({ ...policy, refundCommission })}
      />
      <Button
        label="Publish new policy version for owner acceptance"
        disabled={action.busy || reason.length < 10}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/admin/organizations/${org.id}/policy`, {
              commissionBps: Number(policy.commission) * 100,
              refundCutoffHours: Number(policy.cutoff),
              taxRegistration: policy.tax,
              terms: policy.terms,
              refundCommission: policy.refundCommission,
              processingFeeBearer: 'seller',
              payoutModel: 'stripe-managed',
              reason,
            });
            await reload();
            action.setMessage('New policy recorded. Seller acceptance is required.');
          })
        }
      />
      <Text style={op.title}>Ownership</Text>
      {org.members
        .filter((m) => m.role === 'owner' && m.status === 'active')
        .map((m) => (
          <Button
            key={m.id}
            label={`${outgoing === m.user_id ? '● ' : ''}Outgoing owner: ${m.email ?? m.user_id}`}
            onPress={() => setOutgoing(m.user_id)}
          />
        ))}
      <Field label="Incoming owner account ID (find under Users)" value={incoming} onChange={setIncoming} />
      <Button
        label="Request incoming owner acceptance"
        disabled={action.busy || !outgoing || !incoming || reason.length < 10}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/admin/organizations/${org.id}/ownership`, {
              fromUserId: outgoing,
              toUserId: incoming,
              expectedVersion: org.version,
              reason,
            });
            await reload();
            action.setMessage('Ownership request sent for acceptance.');
          })
        }
      />
      {org.ownershipRequests.map((r) => (
        <View key={r.id}>
          <Text style={op.text}>
            Pending acceptance by {r.to_user_id} until {new Date(r.expires_at).toLocaleString()}
          </Text>
          <Button
            label="Revoke ownership request"
            disabled={action.busy || reason.length < 10}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/admin/organization-ownership/${r.id}/revoke`, { reason });
                await reload();
              })
            }
          />
        </View>
      ))}
      <Text style={op.title}>Venue controls</Text>
      {org.venues.map((v) => (
        <VenueControl key={`${v.id}:${v.version}`} value={v} reason={reason} reload={reload} />
      ))}
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function VenueControl({
  value: v,
  reason,
  reload,
}: {
  value: z.infer<typeof organizationDetail>['venues'][number];
  reason: string;
  reload: () => Promise<void>;
}) {
  const action = useAction(),
    [external, setExternal] = useState(v.commercial_mode === 'external'),
    [url, setUrl] = useState(v.external_url ?? '');
  return (
    <View style={op.box}>
      <Text style={op.text}>
        {v.name} · {v.status}
      </Text>
      <Button
        label={v.status === 'published' ? 'Hide venue' : 'Publish venue'}
        disabled={action.busy || reason.length < 10}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/admin/venues/${v.id}/publication`, {
              status: v.status === 'published' ? 'hidden' : 'published',
              expectedVersion: v.version,
              reason,
            });
            await reload();
          })
        }
      />
      <Toggle label="Purchases take place with an external seller" value={external} onChange={setExternal} />
      {external ? <Field label="External seller HTTPS booking link" value={url} onChange={setUrl} /> : null}
      <Button
        label="Save commercial model"
        disabled={action.busy || reason.length < 10}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/admin/venues/${v.id}/commercial-mode`, {
              mode: external ? 'external' : 'native',
              externalUrl: external ? url : null,
              expectedVersion: v.version,
              reason,
            });
            await reload();
          })
        }
      />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function Audit() {
  const action = useAction(),
    [filter, setFilter] = useState({ actorId: '', resourceId: '', action: '' }),
    [cursor, setCursor] = useState<string | null>(null);
  const schema = z.object({
    id: z.string(),
    actor_id: z.string().nullable(),
    action: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    reason: z.string(),
    created_at: z.string(),
  });
  const [rows, setRows] = useState<z.infer<typeof schema>[]>([]);
  async function load(more = false) {
    const query = new URLSearchParams(
      Object.fromEntries(
        Object.entries(filter)
          .filter(([, v]) => v.trim())
          .map(([k, v]) => [k, v.trim()]),
      ),
    );
    if (more && cursor) query.set('before', cursor);
    const result = z
      .object({ data: z.array(schema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(await api.request(`/v1/admin/audit?${query}`));
    setRows((previous) => (more ? [...previous, ...result.data] : result.data));
    setCursor(result.meta.nextCursor);
  }
  return (
    <View style={op.box}>
      {Object.entries({
        actorId: 'Actor account ID (optional)',
        resourceId: 'Resource ID (optional)',
        action: 'Action name (optional)',
      }).map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={filter[key as keyof typeof filter]}
          onChange={(value) => {
            setFilter({ ...filter, [key]: value });
            setCursor(null);
            setRows([]);
          }}
        />
      ))}
      <Button
        label="Search audit history"
        disabled={action.busy}
        onPress={() => void action.run(() => load())}
      />
      {rows.map((r) => (
        <View key={r.id} style={op.box}>
          <Text selectable style={op.text}>
            {new Date(r.created_at).toLocaleString()} · {r.action}
            {'\n'}
            {r.resource_type}: {r.resource_id}
            {'\n'}Actor: {r.actor_id ?? 'System'}
            {'\n'}
            {r.reason}
          </Text>
        </View>
      ))}
      {cursor ? (
        <Button
          label="Load older audit entries"
          disabled={action.busy}
          onPress={() => void action.run(() => load(true))}
        />
      ) : null}
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
export function OwnershipInvitations({ onAccepted }: { onAccepted: () => Promise<void> }) {
  const action = useAction(),
    [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const invitation = z.object({
    id: z.string(),
    name: z.string(),
    expires_at: z.string(),
    terms: z.string().nullable(),
    commission_bps: z.number().nullable(),
  });
  const [rows, setRows] = useState<z.infer<typeof invitation>[]>([]);
  async function load() {
    setRows(
      z
        .object({ data: z.array(invitation) })
        .parse(await api.request('/v1/me/organization-ownership-invitations')).data,
    );
  }
  useEffect(() => {
    void action.run(load);
  }, []);
  return (
    <View style={op.box}>
      <Text style={op.title}>Organization ownership requests</Text>
      {rows.length === 0 ? <Text style={op.text}>No pending requests.</Text> : null}
      {rows.map((r) => (
        <View key={r.id} style={op.box}>
          <Text style={op.title}>{r.name}</Text>
          <Text style={op.text}>
            Expires {new Date(r.expires_at).toLocaleString()}
            {'\n'}
            {r.terms ?? 'No commercial policy has been published yet.'}
            {r.commission_bps !== null ? `\nCommission: ${r.commission_bps / 100}%` : ''}
          </Text>
          <Toggle
            label="I accept ownership and responsibility for this organization's staff, events, sales and customer obligations."
            value={Boolean(accepted[r.id])}
            onChange={(value) => setAccepted({ ...accepted, [r.id]: value })}
          />
          <Button
            label="Accept organization ownership"
            disabled={action.busy || !accepted[r.id]}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/organization-ownership/${r.id}/accept`, { acceptResponsibilities: true });
                await load();
                await onAccepted();
              })
            }
          />
        </View>
      ))}
      <Button
        label="Refresh ownership requests"
        disabled={action.busy}
        onPress={() => void action.run(load)}
      />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}

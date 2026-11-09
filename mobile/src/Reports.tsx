import { useState } from 'react';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { reportSchema, type Report } from '@clubby/contracts';
import { api } from './session';
import type { Access } from './Support';
import { Button, Field, op, useAction } from './OperationsUI';
import ExportDocument from './ExportDocument';
const money = (minor: string, currency: string) => {
  const value = BigInt(minor),
    absolute = value < 0n ? -value : value;
  return `${currency} ${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};
const percent = (a: string, b: string | number) =>
  BigInt(b) > 0n ? `${Number((BigInt(a) * 1000n) / BigInt(b)) / 10}%` : '—';
export default function Reports({ access }: { access: Access }) {
  const scopes = [
    ...(access.platform.some((r) => ['admin', 'finance'].includes(r))
      ? [{ id: 'platform', name: 'All platform sellers' }]
      : []),
    ...access.organizations.filter((o) => o.permissions.includes('finance.read')),
  ];
  const action = useAction(),
    [scope, setScope] = useState(scopes[0]?.id ?? ''),
    [filters, setFilters] = useState({
      from: new Date(Date.now() - 30 * 86400_000).toISOString(),
      to: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      venueId: '',
      occurrenceId: '',
      currency: '',
    }),
    [result, setResult] = useState<Report | null>(null),
    [exportId, setExportId] = useState(''),
    [exportStatus, setExportStatus] = useState(''),
    [document, setDocument] = useState<{ filename: string; contents: string } | null>(null);
  const input = () =>
    Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value.trim())
        .map(([key, value]) => [key, value.trim()]),
    );
  const endpoint = scope === 'platform' ? '/v1/admin' : `/v1/organizations/${scope}`;
  async function checkExport() {
    const response = z
      .object({ data: z.object({ status: z.string(), report: reportSchema.nullable() }) })
      .parse(await api.request(`/v1/report-exports/${exportId}`));
    setExportStatus(response.data.status);
    if (response.data.report)
      setDocument(
        z
          .object({ data: z.object({ filename: z.string(), contents: z.string() }) })
          .parse(await api.request(`/v1/report-exports/${exportId}/document`)).data,
      );
  }
  return (
    <View style={op.box}>
      <Text style={op.title}>Reports</Text>
      <View style={op.row}>
        {scopes.map((s) => (
          <Button
            key={s.id}
            label={`${scope === s.id ? '● ' : ''}${s.name}`}
            onPress={() => {
              setScope(s.id);
              setResult(null);
              setExportId('');
              setDocument(null);
              setExportStatus('');
            }}
          />
        ))}
      </View>
      {Object.entries({
        from: 'From (ISO date/time with timezone)',
        to: 'To, exclusive (ISO date/time with timezone)',
        timezone: 'Reporting timezone',
        venueId: 'Venue ID (optional)',
        occurrenceId: 'Event occurrence ID (optional)',
        currency: 'Currency code (optional)',
      }).map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={filters[key as keyof typeof filters]}
          onChange={(value) => {
            setFilters({ ...filters, [key]: value });
            setResult(null);
          }}
        />
      ))}
      <Text style={op.text}>
        Money follows ledger posting dates. Checkout conversion follows orders started in the window. Event
        utilization follows event start dates. Refunds and repeat buyers reflect current recorded outcomes.
      </Text>
      <View style={op.row}>
        <Button
          label="Run report"
          disabled={action.busy || !scope}
          onPress={() =>
            void action.run(async () => {
              const params = new URLSearchParams(input());
              setResult(
                z.object({ data: reportSchema }).parse(await api.request(`${endpoint}/reports?${params}`))
                  .data,
              );
            })
          }
        />
        <Button
          label="Prepare snapshot export"
          disabled={action.busy || !scope}
          onPress={() =>
            void action.run(async () => {
              const value = z
                .object({ data: z.object({ id: z.string(), status: z.string() }) })
                .parse(await api.post(`${endpoint}/report-exports`, input(), Crypto.randomUUID()));
              setExportId(value.data.id);
              setExportStatus(value.data.status);
              setDocument(null);
            })
          }
        />
      </View>
      {exportId ? (
        <View style={op.box}>
          <Text style={op.text}>Export: {exportStatus} · expires after seven days</Text>
          <Button
            label="Check export status"
            disabled={action.busy}
            onPress={() => void action.run(checkExport)}
          />
          {document ? <ExportDocument {...document} /> : null}
        </View>
      ) : null}
      {result ? <ReportView value={result} /> : null}
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}
function ReportView({ value: r }: { value: Report }) {
  return (
    <View style={op.box}>
      <Text style={op.text}>
        Generated {new Date(r.generatedAt).toLocaleString()} · {r.filters.timezone}
      </Text>
      <Text style={op.title}>Financial activity</Text>
      {r.financial.length === 0 ? <Text style={op.text}>No financial activity in this window.</Text> : null}
      {r.financial.map((row) => (
        <View key={`${row.day}:${row.currency}`} style={op.box}>
          <Text style={op.text}>
            {row.day} · {row.currency}
          </Text>
          {(
            Object.entries({
              grossMinor: 'Captured sales',
              refundMinor: 'Refunds',
              commissionMinor: 'Net commission',
              chargebackLossMinor: 'Chargeback loss net of recovery',
              netOnlineMinor: 'Net online collections',
              sellerNetBeforeProviderFeesMinor: 'Seller net before provider fees',
              doorCollectedMinor: 'Door collections net of reversals',
              receivableMovementMinor: 'Change in table balances due',
            }) as [keyof typeof row, string][]
          ).map(([key, label]) => (
            <Text key={key} style={op.text}>
              {label}: {money(row[key], row.currency)}
            </Text>
          ))}
        </View>
      ))}
      <Text style={op.title}>Checkout cohorts</Text>
      {r.cohort.map((row) => (
        <Text key={row.currency} style={op.text}>
          {row.currency}: {row.checkoutsPaid} paid of {row.checkoutsStarted} started (
          {percent(row.checkoutsPaid, row.checkoutsStarted)}) · {row.buyers} buyers · {row.repeatBuyers}{' '}
          repeat buyers
        </Text>
      ))}
      <Text style={op.title}>Door activity</Text>
      <Text style={op.text}>
        {r.admissions.admissions} admissions · {r.admissions.drinks} drinks · {r.admissions.rejectedScans}{' '}
        rejected scans
      </Text>
      <Text style={op.title}>Event utilization</Text>
      {r.events.map((e) => (
        <View key={e.id} style={op.box}>
          <Text selectable style={op.text}>
            {e.title} · {new Date(e.startsAt).toLocaleString(undefined, { timeZone: e.timezone })} (
            {e.timezone}) · {e.status}
            {'\n'}
            {e.id}
          </Text>
          <Text style={op.text}>
            {e.activeAdmissions} active admissions / {e.capacity} capacity (
            {percent(e.activeAdmissions, e.capacity)}) · {e.admitted} admitted{'\n'}
            {e.confirmedTables} confirmed/no-show tables · {e.noShowTables} no-shows
          </Text>
        </View>
      ))}
      <Text style={op.title}>Current reconciliation</Text>
      <Text style={op.text}>
        Lifetime order-versus-ledger checks for this scope. These do not confirm bank settlement.
      </Text>
      {r.reconciliation.map((row) => (
        <View key={row.currency} style={op.box}>
          <Text style={op.text}>
            {row.currency}: capture difference {money(row.captureDifferenceMinor, row.currency)}; refund
            difference {money(row.refundDifferenceMinor, row.currency)}
            {'\n'}
            {row.unallocatedProviderRefunds} provider refunds awaiting allocation; {row.ordersUnderReview}{' '}
            orders under review{'\n'}Current table balances due:{' '}
            {money(row.currentTableReceivableMinor, row.currency)}
          </Text>
        </View>
      ))}
      {r.provider ? (
        <>
          <Text style={op.title}>Provider account activity</Text>
          {r.provider.activity.map((row) => (
            <Text key={row.currency} style={op.text}>
              {row.currency}: amount {money(row.amountMinor, row.currency)} · fees{' '}
              {money(row.feeMinor, row.currency)} · net {money(row.netMinor, row.currency)}
            </Text>
          ))}
          {r.provider.freshness.map((row) => (
            <Text key={row.organizationId} style={op.text}>
              Seller {row.organizationId}: latest reconciliation {row.latestStatus ?? 'not run'} · last
              matched {row.lastMatchedAt ? new Date(row.lastMatchedAt).toLocaleString() : 'never'}
            </Text>
          ))}
          <Text style={op.title}>Payouts by arrival date</Text>
          {r.provider.payouts.map((row) => (
            <Text key={`${row.currency}:${row.status}`} style={op.text}>
              {row.count} {row.status} · {money(row.amountMinor, row.currency)}
            </Text>
          ))}
        </>
      ) : (
        <Text style={op.text}>
          Account-wide provider activity is available only with an unrestricted seller or platform report.
        </Text>
      )}
    </View>
  );
}

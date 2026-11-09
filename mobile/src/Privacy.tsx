import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { api, signOut } from './session';
import { Button, Field, Toggle, op, useAction } from './OperationsUI';
import ExportDocument from './ExportDocument';
const receiptSchema = z.object({ id: z.string().uuid(), receipt: z.string() });
const requestSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  dueAt: z.string(),
  expiresAt: z.string().nullable(),
});
const receiptKey = 'clubby.privacy-receipt';
export default function Privacy({ signedIn, onDeleted }: { signedIn: boolean; onDeleted: () => void }) {
  const action = useAction(),
    [requests, setRequests] = useState<z.infer<typeof requestSchema>[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [receipt, setReceipt] = useState<z.infer<typeof receiptSchema> | null>(null),
    [status, setStatus] = useState(''),
    [document, setDocument] = useState<{ filename: string; contents: string } | null>(null);
  async function refresh() {
    setRequests(
      z.object({ data: z.array(requestSchema) }).parse(await api.request('/v1/privacy/requests')).data,
    );
  }
  useEffect(() => {
    if (signedIn) void action.run(refresh);
    else {
      setRequests([]);
      setDocument(null);
    }
  }, [signedIn]);
  useEffect(() => {
    void (async () => {
      const saved =
        Platform.OS === 'web'
          ? sessionStorage.getItem(receiptKey)
          : await SecureStore.getItemAsync(receiptKey);
      if (saved) setReceipt(receiptSchema.parse(JSON.parse(saved)));
    })().catch(() => {});
  }, []);
  return (
    <View style={op.box}>
      <Text style={op.title}>Privacy and account data</Text>
      {signedIn ? (
        <>
          <Text style={op.text}>
            Request a copy of your data or delete your account. Export files remain available for seven days.
          </Text>
          <Button
            label="Request data export"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post('/v1/privacy/requests', { kind: 'export' });
                await refresh();
              })
            }
          />
          <Button label="Refresh requests" disabled={action.busy} onPress={() => void action.run(refresh)} />
          {requests.map((r) => (
            <View key={r.id}>
              <Text style={op.text}>
                {r.kind}: {r.status} · target date {new Date(r.dueAt).toLocaleDateString()}
              </Text>
              {r.kind === 'export' &&
              r.status === 'completed' &&
              r.expiresAt &&
              Date.parse(r.expiresAt) > Date.now() ? (
                <Button
                  label="Open my export"
                  disabled={action.busy}
                  onPress={() =>
                    void action.run(async () => {
                      const result = await api.request(`/v1/privacy/requests/${r.id}/export`);
                      setDocument({
                        filename: `clubby-personal-data-${r.id}.json`,
                        contents: JSON.stringify(result, null, 2),
                      });
                    })
                  }
                />
              ) : null}
            </View>
          ))}
          {document ? <ExportDocument {...document} format="json" /> : null}
          <Text style={op.text}>
            Deletion removes your profile, messages, uploaded images, saved cards and sign-in links. You lose
            account access and unused admissions held by your account. Transfer tickets or group ownership
            first if you want to preserve them. Deletion does not request a refund or cancel outstanding
            payment obligations. Unfunded groups you own are cancelled through the contribution refund
            workflow. Other people’s paid tickets remain theirs. New sales pause for a seller with no
            remaining owner.
          </Text>
          <Text style={op.text}>
            Transaction and audit records remain under the applicable retention policy. A documented legal
            restriction may retain specific data until its review date. Processing normally starts within
            minutes; requests awaiting provider recovery are tracked against a 30-day target. Keep the receipt
            below to check completion after signing out.
          </Text>
          <Toggle
            label="I understand these consequences and want to delete my account"
            value={confirmed}
            onChange={setConfirmed}
          />
          <Button
            label="Delete my account"
            disabled={action.busy || !confirmed}
            onPress={() =>
              void action.run(async () => {
                const result = z
                  .object({ data: receiptSchema })
                  .parse(
                    await api.post('/v1/privacy/requests', { kind: 'delete', confirmConsequences: true }),
                  ).data;
                setReceipt(result);
                const serialized = JSON.stringify(result);
                if (Platform.OS === 'web') sessionStorage.setItem(receiptKey, serialized);
                else await SecureStore.setItemAsync(receiptKey, serialized);
                setConfirmed(false);
                setDocument(null);
                await signOut();
                onDeleted();
                setStatus('Deletion requested. Use this receipt to check completion.');
              })
            }
          />
        </>
      ) : null}
      {receipt ? (
        <>
          <Text style={op.text}>
            Deletion receipt · {receipt.id}. Keep it private: it allows access to request status only.
          </Text>
          <ExportDocument
            filename="clubby-deletion-receipt.json"
            contents={JSON.stringify(receipt)}
            format="json"
          />
          <Button
            label="Check deletion status"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                const response = z
                  .object({
                    data: z.object({
                      status: z.string(),
                      dueAt: z.string(),
                      completedAt: z.string().nullable(),
                    }),
                  })
                  .parse(await api.post('/v1/privacy/receipt', receipt));
                setStatus(
                  `${response.data.status}. ${response.data.completedAt ? 'Completed ' + new Date(response.data.completedAt).toLocaleString() : 'Target: ' + new Date(response.data.dueAt).toLocaleDateString()}`,
                );
              })
            }
          />
          <Button
            label="Forget receipt on this device"
            onPress={() =>
              void action.run(async () => {
                if (Platform.OS === 'web') sessionStorage.removeItem(receiptKey);
                else await SecureStore.deleteItemAsync(receiptKey);
                setReceipt(null);
                setStatus('');
              })
            }
          />
        </>
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {status || action.message}
      </Text>
    </View>
  );
}

export function PrivacyOperations() {
  const action = useAction(),
    [rows, setRows] = useState<
      {
        id: string;
        user_id: string;
        kind: string;
        status: string;
        due_at: string;
        error_code: string | null;
        version: number;
        overdue: boolean;
      }[]
    >([]),
    [reason, setReason] = useState(''),
    [userId, setUserId] = useState(''),
    [scope, setScope] = useState('profile'),
    [basis, setBasis] = useState(''),
    [reference, setReference] = useState(''),
    [expiry, setExpiry] = useState(''),
    [holds, setHolds] = useState<
      {
        id: string;
        scope: string;
        legal_basis: string;
        reference: string;
        expires_at: string;
        released_at: string | null;
        erased_at: string | null;
      }[]
    >([]);
  async function refresh() {
    setRows(
      z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              user_id: z.string(),
              kind: z.string(),
              status: z.string(),
              due_at: z.string(),
              error_code: z.string().nullable(),
              version: z.number(),
              overdue: z.boolean(),
            }),
          ),
        })
        .parse(await api.request('/v1/privacy/operations')).data,
    );
  }
  async function loadHolds() {
    setHolds(
      z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              scope: z.string(),
              legal_basis: z.string(),
              reference: z.string(),
              expires_at: z.string(),
              released_at: z.string().nullable(),
              erased_at: z.string().nullable(),
            }),
          ),
        })
        .parse(await api.request(`/v1/privacy/users/${userId}/holds`)).data,
    );
  }
  return (
    <View style={op.box}>
      <Text style={op.title}>Privacy operations</Text>
      <Button
        label="Load outstanding privacy requests"
        onPress={() => void action.run(refresh)}
        disabled={action.busy}
      />
      <Field label="Decision / retry reason" value={reason} onChange={setReason} />
      {rows.map((r) => (
        <View key={r.id}>
          <Text style={op.text}>
            {r.id} · user {r.user_id} · {r.kind}: {r.status} {r.overdue ? 'OVERDUE' : ''} · {r.error_code}
          </Text>
          {r.status === 'review-required' ? (
            <Button
              label="Retry after resolving provider failure"
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/privacy/operations/${r.id}/retry`, {
                    expectedVersion: r.version,
                    reason,
                  });
                  await refresh();
                })
              }
            />
          ) : null}
        </View>
      ))}
      <Text style={op.text}>
        A retention restriction requires a specific legal basis and case reference. It does not stop account
        deletion and retains only the selected data in an encrypted, access-audited record until the stated
        date.
      </Text>
      <Field label="Subject user ID" value={userId} onChange={setUserId} />
      <Field label="Data scope: profile, support or chat" value={scope} onChange={setScope} />
      <Field label="Legal basis" value={basis} onChange={setBasis} multiline />
      <Field label="Case reference" value={reference} onChange={setReference} />
      <Field label="Expiry (ISO timestamp, within one year)" value={expiry} onChange={setExpiry} />
      <Button
        label="Record retention restriction"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/privacy/users/${userId}/holds`, {
              scope,
              legalBasis: basis,
              reference,
              expiresAt: expiry,
            });
            await loadHolds();
          })
        }
      />
      <Button
        label="Load subject retention restrictions"
        disabled={action.busy}
        onPress={() => void action.run(loadHolds)}
      />
      {holds.map((h) => (
        <View key={h.id}>
          <Text style={op.text}>
            {h.scope}: {h.legal_basis} · {h.reference} · expires {h.expires_at}{' '}
            {h.erased_at ? '(erased)' : ''}
          </Text>
          {!h.released_at ? (
            <Button
              label="Release and erase retained copy"
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/privacy/holds/${h.id}/release`, { reason });
                  await loadHolds();
                })
              }
            />
          ) : null}
        </View>
      ))}
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}

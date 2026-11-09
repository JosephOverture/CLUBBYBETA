import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, op, useAction } from './OperationsUI';
const healthSchema = z.object({
  workers: z.number(),
  maintained_workers: z.number(),
  dead_jobs: z.number(),
  due_jobs: z.number(),
  oldest_due_seconds: z.number(),
  expired_leases: z.number(),
  order_reviews: z.number(),
  refund_reviews: z.number(),
  overdue_deletions: z.number(),
  observed_at: z.string(),
  healthy: z.boolean(),
});
const jobSchema = z.object({
  id: z.string(),
  topic: z.string(),
  status: z.string(),
  attempts: z.number(),
  max_attempts: z.number(),
  replay_generation: z.number(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  replayable: z.boolean(),
});
export default function Operations() {
  const action = useAction(),
    [health, setHealth] = useState<z.infer<typeof healthSchema> | null>(null),
    [jobs, setJobs] = useState<z.infer<typeof jobSchema>[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [status, setStatus] = useState('dead'),
    [reason, setReason] = useState('');
  async function load(before?: string) {
    if (!before)
      setHealth(z.object({ data: healthSchema }).parse(await api.request('/v1/admin/operations')).data);
    const response = z
      .object({ data: z.array(jobSchema), meta: z.object({ nextCursor: z.string().nullable() }) })
      .parse(
        await api.request(`/v1/admin/operations/jobs?status=${status}${before ? `&before=${before}` : ''}`),
      );
    setJobs((old) => (before ? [...old, ...response.data] : response.data));
    setCursor(response.meta.nextCursor);
  }
  useEffect(() => {
    void action.run(() => load());
  }, [status]);
  return (
    <View style={op.box}>
      <Text style={op.title}>Operational health</Text>
      <Button
        label="Refresh operational status"
        disabled={action.busy}
        onPress={() => void action.run(() => load())}
      />
      {health ? (
        <>
          <Text style={op.text}>
            {health.healthy ? 'No worker backlog alerts' : 'Needs operational review'} · checked{' '}
            {new Date(health.observed_at).toLocaleString()}
          </Text>
          <Text style={op.text}>
            {health.workers} active workers; {health.maintained_workers} with recent maintenance.{' '}
            {health.due_jobs} jobs due; oldest waiting {health.oldest_due_seconds}s. {health.dead_jobs}{' '}
            exhausted jobs; {health.expired_leases} expired leases.
          </Text>
          <Text style={op.text}>
            {health.order_reviews} orders and {health.refund_reviews} refunds need review.{' '}
            {health.overdue_deletions} overdue deletion requests.
          </Text>
        </>
      ) : null}
      <View style={op.row}>
        {['dead', 'queued', 'processing'].map((s) => (
          <Button key={s} label={`${s === status ? '✓ ' : ''}${s}`} onPress={() => setStatus(s)} />
        ))}
      </View>
      <Field label="Recovery reason and underlying fix" value={reason} onChange={setReason} />
      {jobs.map((j) => (
        <View key={j.id} style={op.box}>
          <Text style={op.text}>
            {j.topic} · {j.status} · attempt {j.attempts}/{j.max_attempts} ·{' '}
            {j.error_code ?? 'No recorded error'} · {new Date(j.created_at).toLocaleString()}
          </Text>
          {j.status === 'dead' && j.replayable ? (
            <Button
              label="Retry this repaired job"
              disabled={action.busy}
              onPress={() =>
                void action.run(async () => {
                  await api.post(`/v1/admin/operations/jobs/${j.id}/replay`, {
                    expectedGeneration: j.replay_generation,
                    reason,
                  });
                  await load();
                })
              }
            />
          ) : j.status === 'dead' ? (
            <Text style={op.text}>
              Use the booking, notification or privacy recovery workflow. Generic replay is disabled for this
              operation.
            </Text>
          ) : null}
        </View>
      ))}
      {cursor ? (
        <Button
          label="More jobs"
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

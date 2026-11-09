import { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { z } from 'zod';
import { api } from './session';
const reportsSchema = z.object({
  data: z.array(z.object({ id: z.string(), body: z.string(), reason: z.string() })),
});
const reviewsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), venueId: z.string(), orderId: z.string() })),
});
export default function GroupOperations() {
  const [reports, setReports] = useState<z.infer<typeof reportsSchema>['data'] | null>(null),
    [reviews, setReviews] = useState<z.infer<typeof reviewsSchema>['data']>([]),
    [reason, setReason] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const results = await Promise.allSettled([
      api.request('/v1/admin/message-reports'),
      api.request('/v1/seller/group-financial-reviews'),
    ]);
    if (results[0].status === 'fulfilled') setReports(reportsSchema.parse(results[0].value).data);
    if (results[1].status === 'fulfilled') setReviews(reviewsSchema.parse(results[1].value).data);
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setMessage('');
    try {
      await api.post(path, body);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }
  if (reports === null && !reviews.length) return null;
  return (
    <View style={{ gap: 12, borderWidth: 1, borderColor: '#394236', padding: 16, borderRadius: 12 }}>
      <Text style={{ color: '#f7f6ef', fontSize: 22 }}>Group operations</Text>
      <Pressable accessibilityRole="button" onPress={() => void refresh()}>
        <Text style={{ color: '#cdff80' }}>Refresh reviews</Text>
      </Pressable>
      <TextInput
        accessibilityLabel="Reason for moderation or financial decision"
        value={reason}
        onChangeText={setReason}
        multiline
        style={{ color: '#e1e5dc', padding: 12, borderWidth: 1, borderColor: '#596253' }}
      />
      {reports?.map((report) => (
        <View key={report.id} style={{ gap: 8 }}>
          <Text style={{ color: '#e1e5dc' }}>Reported: {report.body}</Text>
          <Text style={{ color: '#e1e5dc' }}>Reason: {report.reason}</Text>
          {(['hide', 'dismiss'] as const).map((action) => (
            <Pressable
              accessibilityRole="button"
              key={action}
              disabled={busy}
              onPress={() => void act(`/v1/admin/message-reports/${report.id}/resolve`, { action, reason })}
            >
              <Text style={{ color: '#cdff80' }}>
                {action === 'hide' ? 'Hide message and resolve' : 'Dismiss report'}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
      {reviews.map((review) => (
        <View key={review.id}>
          <Text style={{ color: '#e1e5dc' }}>
            {review.name} · {review.venueId} · Booking {review.orderId}. Review the provider dispute and
            completed service before authorizing refunds.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void act(`/v1/seller/groups/${review.id}/refund-review`, { reason })}
          >
            <Text style={{ color: '#cdff80' }}>Authorize cancellation and remaining contributor refunds</Text>
          </Pressable>
        </View>
      ))}
      {message ? (
        <Text accessibilityRole="alert" style={{ color: '#e1e5dc' }}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

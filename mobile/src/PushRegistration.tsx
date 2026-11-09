import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { api } from './session';
export type PushProps = {
  userId: string;
  enabled: boolean;
  onOpen: (id: string) => void;
  onRegistered: () => void;
};
export default function PushRegistration({ userId, enabled, onOpen, onRegistered }: PushProps) {
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const callbacks = useRef({ onOpen, onRegistered });
  callbacks.current = { onOpen, onRegistered };
  useEffect(() => {
    const receive = (response: Notifications.NotificationResponse | null) => {
      const id = response?.notification.request.content.data?.notificationId;
      if (
        response?.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER &&
        typeof id === 'string' &&
        z.string().uuid().safeParse(id).success
      ) {
        callbacks.current.onOpen(id);
        Notifications.clearLastNotificationResponse();
      }
    };
    receive(Notifications.getLastNotificationResponse());
    const listener = Notifications.addNotificationResponseReceivedListener(receive);
    return () => listener.remove();
  }, [userId]);
  async function register(token?: string) {
    let installationId = await SecureStore.getItemAsync('clubby.push.installation');
    if (!installationId) {
      installationId = Crypto.randomUUID();
      await SecureStore.setItemAsync('clubby.push.installation', installationId);
    }
    const value = token ?? String((await Notifications.getDevicePushTokenAsync()).data);
    const response = z
      .object({ data: z.object({ id: z.string().uuid() }) })
      .parse(
        await api.post('/v1/me/devices', {
          installationId,
          token: value,
          environment: process.env.EXPO_PUBLIC_APNS_ENVIRONMENT ?? 'sandbox',
        }),
      );
    await SecureStore.setItemAsync(`clubby.push.${userId}`, response.data.id);
    callbacks.current.onRegistered();
  }
  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios') return;
    let active = true;
    const refresh = async (token?: string) => {
      // A removed device stays removed. Re-enabling requires the account holder's button press.
      const saved = await SecureStore.getItemAsync(`clubby.push.${userId}`);
      if (!saved || !active) return;
      const devices = z
        .object({ data: z.array(z.object({ id: z.string(), current: z.boolean() })) })
        .parse(await api.request('/v1/me/devices'));
      if (!devices.data.some((d) => d.id === saved && d.current) || !active) return;
      const permissions = await Notifications.getPermissionsAsync();
      if (!permissions.granted) return;
      await register(token);
    };
    void refresh().catch(() => {});
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh().catch(() => {});
    });
    const tokens = Notifications.addPushTokenListener((token) => {
      if (token.type === 'ios') void refresh(String(token.data)).catch(() => {});
    });
    return () => {
      active = false;
      appState.remove();
      tokens.remove();
    };
  }, [userId, enabled]);
  if (Platform.OS !== 'ios') return null;
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: '#e1e5dc' }}>
        {enabled
          ? 'Get a private alert when there is an update. Your account inbox works without push permission.'
          : 'Push notifications will be available when this service is configured.'}
      </Text>
      {enabled ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() =>
            void (async () => {
              setBusy(true);
              setMessage('');
              try {
                const permission = await Notifications.requestPermissionsAsync({
                  ios: { allowAlert: true, allowSound: true, allowBadge: false },
                });
                if (!permission.granted) {
                  setMessage(
                    'Push permission is off. You can keep using your inbox or change this in iOS Settings.',
                  );
                  return;
                }
                await register();
                setMessage('Push enabled for this account on this device.');
              } catch {
                setMessage('Push could not be enabled. Please try again.');
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          <Text style={{ color: '#cdff80' }}>Enable notifications on this iPhone</Text>
        </Pressable>
      ) : null}
      {message ? (
        <>
          <Text accessibilityRole="alert" style={{ color: '#e1e5dc' }}>
            {message}
          </Text>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openSettings()}>
            <Text style={{ color: '#cdff80' }}>Open iOS notification settings</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

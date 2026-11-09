import * as Notifications from 'expo-notifications';
export async function clearPushDisplay() {
  Notifications.clearLastNotificationResponse();
  await Notifications.dismissAllNotificationsAsync();
  await Notifications.setBadgeCountAsync(0);
}

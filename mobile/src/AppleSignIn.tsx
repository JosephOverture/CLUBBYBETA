import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { z } from 'zod';
import { api, startAppleSignIn, completeAppleSignIn, session } from './session';
import { op, useAction } from './OperationsUI';
export default function AppleSignIn({
  link = false,
  onComplete,
}: {
  link?: boolean;
  onComplete: (profile: Awaited<ReturnType<typeof session>>) => void;
}) {
  const [available, setAvailable] = useState(false),
    action = useAction();
  useEffect(() => {
    let active = true;
    void Promise.all([AppleAuthentication.isAvailableAsync(), api.request('/v1/auth/apple/config')])
      .then(([native, config]) => {
        if (active)
          setAvailable(
            native && z.object({ data: z.object({ enabled: z.boolean() }) }).parse(config).data.enabled,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!available) return null;
  return (
    <View style={{ gap: 8 }}>
      {link ? <Text style={op.text}>Link Apple to this Clubby account</Text> : null}
      <Text style={op.text}>
        If you later revoke Clubby’s access in Apple settings or delete your Apple Account, Clubby will start
        deleting this account and revoke its sessions. Transfer unused tickets and group ownership first if
        needed.
      </Text>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
        cornerRadius={8}
        style={{ width: 260, height: 48, opacity: action.busy ? 0.5 : 1 }}
        onPress={() => {
          if (action.busy) return;
          void action.run(async () => {
            const start = await startAppleSignIn(link);
            const credential = await AppleAuthentication.signInAsync({
              requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
              state: start.state,
              nonce: start.nonce,
            });
            if (!credential.authorizationCode || !credential.state)
              throw new Error('Apple sign-in was not completed.');
            onComplete(await completeAppleSignIn(start, credential.authorizationCode, credential.state));
          });
        }}
      />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}

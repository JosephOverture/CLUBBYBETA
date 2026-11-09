import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api, startAppleSignIn, completeAppleSignIn, session } from './session';
import { Button, op } from './OperationsUI';
type AppleSDK = {
  auth: {
    init(config: {
      clientId: string;
      scope: string;
      redirectURI: string;
      state: string;
      nonce: string;
      usePopup: boolean;
    }): void;
  };
};
declare global {
  interface Window {
    AppleID?: AppleSDK;
  }
}
let sdkFlight: Promise<void> | undefined;
function loadSDK() {
  if (window.AppleID) return Promise.resolve();
  if (!sdkFlight)
    sdkFlight = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
      script.async = true;
      const timeout = setTimeout(() => {
        script.remove();
        sdkFlight = undefined;
        reject(new Error('Apple sign-in did not load.'));
      }, 10000);
      script.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        script.remove();
        sdkFlight = undefined;
        reject(new Error('Apple sign-in did not load.'));
      };
      document.head.appendChild(script);
    });
  return sdkFlight;
}
export default function AppleSignIn({
  link = false,
  onComplete,
}: {
  link?: boolean;
  onComplete: (profile: Awaited<ReturnType<typeof session>>) => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [ready, setReady] = useState(false),
    [message, setMessage] = useState(''),
    [attempt, setAttempt] = useState(0);
  const prepared = useRef<Awaited<ReturnType<typeof startAppleSignIn>> | null>(null),
    completing = useRef(false),
    callback = useRef(onComplete);
  callback.current = onComplete;
  useEffect(() => {
    let active = true;
    void api
      .request('/v1/auth/apple/config')
      .then((value) => {
        if (active)
          setEnabled(z.object({ data: z.object({ enabled: z.boolean() }) }).parse(value).data.enabled);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setReady(false);
    prepared.current = null;
    setMessage('');
    void Promise.all([loadSDK(), startAppleSignIn(link)])
      .then(([, start]) => {
        if (!active) return;
        if (!start.redirectURI || !window.AppleID) throw new Error('Apple sign-in is unavailable.');
        prepared.current = start;
        window.AppleID.auth.init({
          clientId: start.clientId,
          scope: 'email',
          redirectURI: start.redirectURI,
          state: start.state,
          nonce: start.nonce,
          usePopup: true,
        });
        setReady(true);
      })
      .catch((e) => {
        if (active) setMessage(e instanceof Error ? e.message : 'Apple sign-in is unavailable.');
      });
    const success = (event: Event) => {
      if (!prepared.current || completing.current) return;
      const start = prepared.current;
      completing.current = true;
      setReady(false);
      void (async () => {
        try {
          const result = z
            .object({ authorization: z.object({ code: z.string(), state: z.string() }) })
            .parse((event as CustomEvent).detail);
          const profile = await completeAppleSignIn(
            start,
            result.authorization.code,
            result.authorization.state,
          );
          if (active) callback.current(profile);
        } catch (e) {
          if (active) setMessage(e instanceof Error ? e.message : 'Unable to sign in with Apple.');
        } finally {
          completing.current = false;
          prepared.current = null;
        }
      })();
    };
    const failure = () => {
      if (active) {
        setReady(false);
        setMessage('Apple sign-in was cancelled or could not be completed. Try again.');
      }
    };
    document.addEventListener('AppleIDSignInOnSuccess', success);
    document.addEventListener('AppleIDSignInOnFailure', failure);
    return () => {
      active = false;
      document.removeEventListener('AppleIDSignInOnSuccess', success);
      document.removeEventListener('AppleIDSignInOnFailure', failure);
    };
  }, [enabled, link, attempt]);
  if (!enabled) return null;
  return (
    <View style={{ gap: 8 }}>
      {link ? <Text style={op.text}>Link Apple to this Clubby account</Text> : null}
      <Text style={op.text}>
        If you later revoke Clubby’s access in Apple settings or delete your Apple Account, Clubby will start
        deleting this account and revoke its sessions. Transfer unused tickets and group ownership first if
        needed.
      </Text>
      <div
        id="appleid-signin"
        data-color="white"
        data-border="true"
        data-type="continue"
        style={{ width: 260, height: 48, pointerEvents: ready ? 'auto' : 'none', opacity: ready ? 1 : 0.5 }}
      />
      {message ? (
        <>
          <Text accessibilityRole="alert" style={op.text}>
            {message}
          </Text>
          <Button label="Prepare Apple sign-in again" onPress={() => setAttempt((v) => v + 1)} />
        </>
      ) : null}
    </View>
  );
}

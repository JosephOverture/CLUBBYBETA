import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { ClubbyApiError } from '@clubby/api-client';
import { api, startSignIn, completeSignIn, session, signOut } from './session';
import { MyBookings } from './Bookings';
import DoorScanner from './DoorScanner';
import Groups from './Groups';
import GroupOperations from './GroupOperations';
import Tickets from './Tickets';
import SavedMethods from './SavedMethods';
import Notifications, { type NotificationTarget } from './Notifications';
import Support, { accessSchema, type Access, type SupportDraft } from './Support';
import Administration, { OwnershipInvitations } from './Administration';
import Reports from './Reports';
import AppleSignIn from './AppleSignIn';
import Privacy, { PrivacyOperations } from './Privacy';
import SellerAccount from './SellerAccount';
import Discovery from './Discovery';
import { parseDeepLink } from './deep-links';
import { Button, Field, op, useAction } from './OperationsUI';

type Profile = Awaited<ReturnType<typeof session>>;
type Section =
  | 'discover'
  | 'account'
  | 'bookings'
  | 'tickets'
  | 'groups'
  | 'inbox'
  | 'support'
  | 'seller'
  | 'door'
  | 'reports'
  | 'admin';
export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null),
    [access, setAccess] = useState<Access | null>(null),
    [section, setSection] = useState<Section>('discover'),
    [bookingId, setBookingId] = useState<string | null>(null),
    [groupId, setGroupId] = useState<string | null>(null),
    [ticketId, setTicketId] = useState<string | null>(null),
    [supportId, setSupportId] = useState<string | null>(null),
    [supportDraft, setSupportDraft] = useState<SupportDraft | null>(null),
    [message, setMessage] = useState('');
  const scroll = useRef<ScrollView>(null);
  function navigate(next: Section) {
    setSection(next);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }
  function cleared(statusMessage = '') {
    setMessage(statusMessage);
    setProfile(null);
    setAccess(null);
    setBookingId(null);
    setGroupId(null);
    setTicketId(null);
    setSupportId(null);
    setSupportDraft(null);
    navigate('account');
  }
  function booked(id: string) {
    setBookingId(id);
    navigate('bookings');
  }
  function grouped(id: string) {
    setGroupId(id);
    navigate('groups');
  }
  function support(draft: SupportDraft) {
    setSupportId(null);
    setSupportDraft(draft);
    navigate('support');
  }
  function notification(target: NotificationTarget) {
    if (target.kind === 'booking') booked(target.id);
    if (target.kind === 'group') grouped(target.id);
    if (target.kind === 'ticket') {
      setTicketId(target.id);
      navigate('tickets');
    }
    if (target.kind === 'support') {
      setSupportDraft(null);
      setSupportId(target.id);
      navigate('support');
    }
  }
  async function refreshAccess() {
    setAccess(accessSchema.parse(await api.request('/v1/me/access')).data);
  }
  useEffect(() => {
    let active = true;
    void session()
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch((error) => {
        if (active && !(error instanceof ClubbyApiError && error.status === 401))
          setMessage('Could not restore your session. Check your connection and try signing in.');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setAccess(null);
    if (profile?.kind === 'registered')
      void api
        .request('/v1/me/access')
        .then((result) => {
          if (active) setAccess(accessSchema.parse(result).data);
        })
        .catch(() => {
          if (active) setMessage('Staff permissions could not be loaded. Refresh access from your account.');
        });
    return () => {
      active = false;
    };
  }, [profile?.id]);
  useEffect(() => {
    if (!profile) return;
    let active = true,
      running = false;
    const verify = async () => {
      if (
        running ||
        !active ||
        (Platform.OS === 'web' ? document.visibilityState !== 'visible' : AppState.currentState !== 'active')
      )
        return;
      running = true;
      try {
        const current = await session();
        if (!active) return;
        setProfile(current);
        if (current.kind === 'registered') {
          const result = accessSchema.parse(await api.request('/v1/me/access'));
          if (active) setAccess(result.data);
        }
      } catch (error) {
        if (active && error instanceof ClubbyApiError && error.status === 401) {
          await signOut();
          if (active) {
            cleared();
            setMessage('Your session ended. Sign in again if your account remains active.');
          }
        }
      } finally {
        running = false;
      }
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void verify();
    });
    const visible = () => void verify();
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => void verify(), 60000);
    return () => {
      active = false;
      subscription.remove();
      clearInterval(timer);
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', visible);
    };
  }, [profile?.id]);
  useEffect(() => {
    const receive = (value: string) => {
      const target = parseDeepLink(
        value,
        process.env.EXPO_PUBLIC_WEB_URL ?? (Platform.OS === 'web' ? window.location.origin : undefined),
      );
      if (target) notification(target);
    };
    void Linking.getInitialURL().then((value) => {
      if (value) receive(value);
    });
    const subscription = Linking.addEventListener('url', (event) => receive(event.url));
    if (Platform.OS === 'web') {
      receive(window.location.href);
      const url = new URL(window.location.href);
      for (const key of ['payment_intent', 'payment_intent_client_secret', 'redirect_status'])
        url.searchParams.delete(key);
      window.history.replaceState(null, '', url.pathname + url.search);
    }
    return () => subscription.remove();
  }, []);
  const admin = Boolean(access?.platform.includes('admin'));
  const finance = Boolean(
    access &&
    (access.platform.some((r) => ['admin', 'finance'].includes(r)) ||
      access.organizations.some((o) => o.permissions.includes('finance.read'))),
  );
  const door = Boolean(access?.organizations.some((o) => o.permissions.includes('admissions.redeem')));
  const groupOperations = Boolean(
    access?.platform.some((r) => ['admin', 'support'].includes(r)) ||
    access?.organizations.some((o) => o.permissions.includes('booking.refund')),
  );
  const tabs: { id: Section; label: string }[] = [
    { id: 'discover', label: 'Discover' },
    { id: 'account', label: profile ? 'Account' : 'Sign in' },
  ];
  if (profile)
    tabs.push(
      { id: 'bookings', label: 'Bookings' },
      { id: 'tickets', label: 'Tickets' },
      { id: 'groups', label: 'Groups' },
      { id: 'inbox', label: 'Notifications' },
      { id: 'support', label: 'Support' },
    );
  if (profile?.kind === 'registered') tabs.push({ id: 'seller', label: 'Seller workspace' });
  if (door) tabs.push({ id: 'door', label: 'Door' });
  if (finance) tabs.push({ id: 'reports', label: 'Reports' });
  if (admin) tabs.push({ id: 'admin', label: 'Administration' });
  const current = tabs.some((t) => t.id === section) ? section : 'account';
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#101210' }}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: 24, gap: 20, maxWidth: 840, width: '100%', alignSelf: 'center' }}
      >
        <Text style={{ color: '#cdff80', fontSize: 28, fontWeight: '700' }}>CLUBBY</Text>
        <View style={op.row}>
          {tabs.map((t) => (
            <Button
              key={t.id}
              label={`${current === t.id ? '✓ ' : ''}${t.label}`}
              onPress={() => navigate(t.id)}
            />
          ))}
        </View>
        {message ? (
          <Text style={op.text} accessibilityRole="alert">
            {message}
          </Text>
        ) : null}
        {current === 'discover' ? (
          <Discovery
            key={profile?.id ?? 'public'}
            userId={profile?.kind === 'registered' ? profile.id : undefined}
            email={profile?.email ?? null}
            onBooked={booked}
            onGroupCreated={grouped}
          />
        ) : null}
        {current === 'account' ? (
          <>
            <Account
              key={`account:${profile?.id ?? 'signin'}`}
              profile={profile}
              onProfile={setProfile}
              onCleared={cleared}
              onAccess={refreshAccess}
            />
            <Privacy signedIn={Boolean(profile)} onDeleted={cleared} />
            {profile ? <SavedMethods key={`saved-methods:${profile.id}`} /> : null}
            {profile?.kind === 'registered' ? (
              <OwnershipInvitations key={`ownership:${profile.id}`} onAccepted={refreshAccess} />
            ) : null}
          </>
        ) : null}
        {profile ? (
          <>
            {current === 'bookings' ? (
              <MyBookings
                selectedId={bookingId}
                onSelected={setBookingId}
                userId={profile.id}
                onGroupSelected={grouped}
                onSupport={(id) => support({ kind: 'booking', id })}
              />
            ) : null}
            {current === 'tickets' ? (
              <Tickets
                key={profile.id}
                selectedId={ticketId}
                onSupport={(id) => support({ kind: 'ticket', id })}
              />
            ) : null}
            {current === 'groups' ? (
              <>
                <Groups
                  key={`groups:${profile.id}`}
                  userId={profile.id}
                  selectedId={groupId}
                  onSelected={setGroupId}
                  onPayment={booked}
                />
                {groupOperations ? <GroupOperations key={`group-operations:${profile.id}`} /> : null}
              </>
            ) : null}
            {current === 'inbox' ? (
              <Notifications key={profile.id} userId={profile.id} onNavigate={notification} />
            ) : null}
            {current === 'support' ? (
              <Support
                key={profile.id}
                userId={profile.id}
                access={access}
                selectedId={supportId}
                onSelected={setSupportId}
                draft={supportDraft}
                onDraft={setSupportDraft}
              />
            ) : null}
            {current === 'seller' && profile.kind === 'registered' ? (
              <SellerAccount key={profile.id} access={access} onChanged={refreshAccess} />
            ) : null}
            {current === 'door' && door ? <DoorScanner key={profile.id} /> : null}
            {current === 'reports' && finance && access ? <Reports key={profile.id} access={access} /> : null}
            {current === 'admin' && admin ? (
              <>
                <Administration key={`administration:${profile.id}`} onChanged={refreshAccess} />
                <PrivacyOperations key={`privacy-operations:${profile.id}`} />
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
function Account({
  profile,
  onProfile,
  onCleared,
  onAccess,
}: {
  profile: Profile | null;
  onProfile: (profile: Profile) => void;
  onCleared: (message?: string) => void;
  onAccess: () => Promise<void>;
}) {
  const action = useAction(),
    [email, setEmail] = useState(''),
    [code, setCode] = useState(''),
    [sent, setSent] = useState(false),
    [name, setName] = useState(profile?.displayName ?? '');
  return (
    <View style={op.box}>
      <Text style={op.title}>{profile ? 'Your account' : 'Sign in'}</Text>
      {profile ? (
        <>
          <Text style={op.text}>{profile.email ?? 'Guest account'}</Text>
          {profile.kind === 'registered' ? (
            <>
              <Field label="Display name" value={name} onChange={setName} />
              <Button
                label="Save display name"
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await api.post('/v1/auth/profile', { displayName: name });
                    onProfile(await session());
                    action.setMessage('Profile updated.');
                  })
                }
              />
              <AppleSignIn link onComplete={onProfile} />
              <Button
                label="Refresh staff access"
                disabled={action.busy}
                onPress={() => void action.run(onAccess)}
              />
            </>
          ) : null}
          <Button
            label="Sign out"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                const result = await signOut();
                onCleared(
                  result.remote
                    ? ''
                    : 'Local credentials cleared. The service could not confirm remote revocation.',
                );
              })
            }
          />
        </>
      ) : (
        <>
          <AppleSignIn onComplete={onProfile} />
          <Field label="Email address" value={email} onChange={setEmail} />
          {sent ? <Field label="Sign-in code" value={code} onChange={setCode} /> : null}
          <Button
            label={sent ? 'Continue with email code' : 'Email me a code'}
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                if (sent) {
                  onProfile(await completeSignIn(code.trim()));
                  setCode('');
                  setSent(false);
                } else {
                  await startSignIn(email.trim());
                  setSent(true);
                  action.setMessage('Enter the code sent to your email.');
                }
              })
            }
          />
          {sent ? (
            <Button
              label="Use a different email"
              disabled={action.busy}
              onPress={() => {
                setSent(false);
                setCode('');
              }}
            />
          ) : null}
        </>
      )}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

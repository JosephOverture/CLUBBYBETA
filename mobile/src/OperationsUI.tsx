import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
export const op = StyleSheet.create({
  box: { borderWidth: 1, borderColor: '#394236', borderRadius: 12, padding: 18, gap: 12 },
  title: { color: '#f7f6ef', fontSize: 22, fontWeight: '600' },
  text: { color: '#e1e5dc', fontSize: 15, lineHeight: 22 },
  input: {
    borderWidth: 1,
    borderColor: '#596253',
    color: '#f7f6ef',
    padding: 12,
    borderRadius: 8,
    minHeight: 46,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { backgroundColor: '#cdff80', padding: 12, borderRadius: 8, minHeight: 44 },
});
export function Field({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={op.text}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        style={op.input}
      />
    </View>
  );
}
export function Button({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[op.button, disabled && { opacity: 0.5 }]}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}
export function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <Text style={op.text}>
        {value ? '☑' : '☐'} {label}
      </Text>
    </Pressable>
  );
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unable to complete this action.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, setMessage, run };
}

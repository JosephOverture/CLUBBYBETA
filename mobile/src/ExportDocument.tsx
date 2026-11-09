import { Share, Text, View } from 'react-native';
import { Button, op, useAction } from './OperationsUI';
export default function ExportDocument({
  filename,
  contents,
  format = 'csv',
}: {
  filename: string;
  contents: string;
  format?: 'csv' | 'json';
}) {
  const action = useAction();
  return (
    <View>
      <Button
        label={`Share ${format.toUpperCase()} text`}
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await Share.share({ title: filename, message: contents });
          })
        }
      />
      <Text accessibilityRole="alert" style={op.text}>
        {action.message}
      </Text>
    </View>
  );
}

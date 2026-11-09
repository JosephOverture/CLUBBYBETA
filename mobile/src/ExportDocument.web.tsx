import { Button } from './OperationsUI';
export default function ExportDocument({
  filename,
  contents,
  format = 'csv',
}: {
  filename: string;
  contents: string;
  format?: 'csv' | 'json';
}) {
  return (
    <Button
      label={`Download ${format.toUpperCase()} file`}
      onPress={() => {
        const url = URL.createObjectURL(
          new Blob([contents], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}
    />
  );
}

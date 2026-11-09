import { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, op, useAction } from './OperationsUI';
const assetSchema = z.object({
  id: z.string(),
  alt_text: z.string(),
  status: z.string(),
  event_id: z.string().nullable(),
});
export function SellerMedia({
  kind,
  id,
  version,
  onChanged,
}: {
  kind: 'venues' | 'events';
  id: string;
  version: number;
  onChanged: () => Promise<void>;
}) {
  const action = useAction(),
    [assets, setAssets] = useState<z.infer<typeof assetSchema>[]>([]),
    [alt, setAlt] = useState(''),
    [selected, setSelected] = useState<{ blob: Blob; uri: string; type: string } | null>(null),
    [upload, setUpload] = useState<string | null>(null),
    [preview, setPreview] = useState<string | null>(null);
  const path = `/v1/seller/${kind}/${encodeURIComponent(id)}`;
  async function load() {
    setAssets(
      z
        .object({ data: z.array(assetSchema) })
        .parse(await api.request(`${path}/media`))
        .data.filter((a) => a.status !== 'deleted' && (kind === 'events' || !a.event_id)),
    );
  }
  useEffect(() => {
    void action.run(load);
  }, [id]);
  async function pick() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 0.85,
      allowsEditing: true,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    if (asset.fileSize && asset.fileSize > 5 * 1024 * 1024)
      throw new Error('Select an image of 5 MB or less.');
    const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
    const type = blob.type || asset.mimeType || '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type))
      throw new Error('Choose a JPEG, PNG or WebP image.');
    if (blob.size === 0 || blob.size > 5 * 1024 * 1024) throw new Error('Select an image of 5 MB or less.');
    setSelected({ blob, uri: asset.uri, type });
    setUpload(null);
  }
  async function previewAsset(assetId: string) {
    const blob = await api.blob(`/v1/media/${assetId}/preview/thumbnail`);
    const uri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Image preview could not be loaded.'));
      reader.readAsDataURL(blob);
    });
    setPreview(uri);
  }
  return (
    <View style={op.box}>
      <Text style={op.title}>Cover image</Text>
      <Text style={op.text}>
        JPEG, PNG or WebP, up to 5 MB. Clubby processes images and removes metadata before publication.
      </Text>
      <Field
        label="Image description for accessibility"
        value={alt}
        onChange={(value) => {
          setAlt(value);
          setUpload(null);
        }}
      />
      <Button label="Choose image" disabled={action.busy} onPress={() => void action.run(pick)} />
      {selected ? (
        <>
          <Image
            source={{ uri: selected.uri }}
            accessibilityLabel={alt || 'Selected image'}
            style={{ width: 260, height: 180 }}
          />
          <Button
            label={upload ? 'Retry image upload' : 'Upload selected image'}
            disabled={action.busy || !alt.trim()}
            onPress={() =>
              void action.run(async () => {
                let assetId = upload;
                if (!assetId) {
                  const result = z
                    .object({ data: z.object({ id: z.string() }) })
                    .parse(
                      await api.post(`${path}/media`, {
                        contentType: selected.type,
                        bytes: selected.blob.size,
                        altText: alt,
                      }),
                    );
                  assetId = result.data.id;
                  setUpload(assetId);
                }
                await api.request(`/v1/media/${assetId}/content`, {
                  method: 'PUT',
                  headers: { 'content-type': 'application/octet-stream' },
                  body: selected.blob,
                });
                setSelected(null);
                setUpload(null);
                await load();
                action.setMessage(
                  'Image uploaded. Refresh processing status before selecting it as the cover.',
                );
              })
            }
          />
        </>
      ) : null}
      <Button
        label="Refresh image processing status"
        disabled={action.busy}
        onPress={() => void action.run(load)}
      />
      {assets.map((a) => (
        <View key={a.id}>
          <Text style={op.text}>
            {a.alt_text} · {a.status}
          </Text>
          {a.status === 'ready' ? (
            <View style={op.row}>
              <Button
                label="Preview image"
                disabled={action.busy}
                onPress={() => void action.run(() => previewAsset(a.id))}
              />
              <Button
                label="Use as cover image"
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await api.post(`${path}/hero`, { assetId: a.id, expectedVersion: version });
                    await onChanged();
                    action.setMessage('Cover image saved.');
                  })
                }
              />
            </View>
          ) : null}
          <Button
            label="Delete unused image"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/media/${a.id}/delete`, {});
                await load();
                setPreview(null);
              })
            }
          />
        </View>
      ))}
      {preview ? (
        <Image
          source={{ uri: preview }}
          accessibilityLabel="Processed image preview"
          style={{ width: 260, height: 180 }}
        />
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

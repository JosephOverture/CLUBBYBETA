import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Rect, Ellipse, G, Text as SvgText } from 'react-native-svg';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, Toggle, op, useAction } from './OperationsUI';
import { VenuePicker, zonedInput, type SellerOrganization, type SellerVenue } from './SellerSelectors';
import { decimalMinor } from './SellerSelectors';
import type { SellerInventoryData } from './SellerInventory';
const tableSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  zoneId: z.string(),
  seats: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  rotation: z.number(),
  shape: z.enum(['circle', 'rectangle']),
});
export const layoutSchema = z.object({
  name: z.string(),
  zones: z.array(z.object({ id: z.string(), label: z.string() })),
  tables: z.array(tableSchema),
});
type Layout = z.infer<typeof layoutSchema>;
const savedLayoutSchema = z.object({ id: z.string(), version: z.number(), content: layoutSchema });
function FloorPreview({ layout }: { layout: Layout }) {
  return (
    <View accessibilityLabel="Floor plan preview" style={{ maxWidth: 600, aspectRatio: 1, width: '100%' }}>
      <Svg viewBox="0 0 1000 1000">
        <Rect width="1000" height="1000" fill="#192218" stroke="#899583" />
        {layout.tables.map((t, index) => (
          <G key={t.id ?? index} transform={`translate(${t.x * 1000} ${t.y * 1000}) rotate(${t.rotation})`}>
            {t.shape === 'circle' ? (
              <Ellipse rx={t.width * 500} ry={t.height * 500} fill="#cdff80" />
            ) : (
              <Rect
                x={-t.width * 500}
                y={-t.height * 500}
                width={t.width * 1000}
                height={t.height * 1000}
                fill="#cdff80"
              />
            )}
            <SvgText fontSize="20" textAnchor="middle" fill="#111">
              {t.label}
            </SvgText>
          </G>
        ))}
      </Svg>
    </View>
  );
}
export function SellerLayouts({ organization }: { organization: SellerOrganization }) {
  const [venue, setVenue] = useState<SellerVenue | null>(null);
  return (
    <View style={op.box}>
      <Text style={op.title}>Table floor plans</Text>
      <VenuePicker organizationId={organization.id} value={venue?.id ?? ''} onChange={setVenue} />
      {venue ? <LayoutEditor key={venue.id} venue={venue} /> : null}
    </View>
  );
}
function LayoutEditor({ venue }: { venue: SellerVenue }) {
  const action = useAction(),
    [layouts, setLayouts] = useState<z.infer<typeof savedLayoutSchema>[]>([]),
    [loaded, setLoaded] = useState(false),
    [value, setValue] = useState<Layout>({
      name: 'Main floor',
      zones: [{ id: 'main', label: 'Main room' }],
      tables: [],
    }),
    [selected, setSelected] = useState(0),
    [reason, setReason] = useState(''),
    [blocks, setBlocks] = useState<
      { id: string; tableId: string; startsAt: string; endsAt: string; reason: string }[]
    >([]),
    [blockStart, setBlockStart] = useState(''),
    [blockEnd, setBlockEnd] = useState('');
  const pendingBlock = useRef<{ payload: string; key: string } | null>(null);
  async function load() {
    const response = z
      .object({ data: z.array(savedLayoutSchema) })
      .parse(await api.request(`/v1/seller/venues/${encodeURIComponent(venue.id)}/layouts`));
    setLayouts(response.data);
    if (response.data[0]) setValue(response.data[0].content);
    setSelected(0);
    setLoaded(true);
  }
  async function loadBlocks() {
    setBlocks(
      z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              tableId: z.string(),
              startsAt: z.string(),
              endsAt: z.string(),
              reason: z.string(),
            }),
          ),
        })
        .parse(await api.request(`/v1/seller/venues/${encodeURIComponent(venue.id)}/table-blocks`)).data,
    );
  }
  useEffect(() => {
    void action.run(async () => {
      await load();
      await loadBlocks();
    });
  }, [venue.id]);
  const table = value.tables[selected];
  function updateTable(patch: Partial<z.infer<typeof tableSchema>>) {
    setValue((v) => ({ ...v, tables: v.tables.map((t, i) => (i === selected ? { ...t, ...patch } : t)) }));
  }
  return (
    <View style={{ gap: 12 }}>
      <Button label="Reload latest floor plan" disabled={action.busy} onPress={() => void action.run(load)} />
      <Text style={op.text}>
        Saving creates a new version. Published offers retain their existing plan. Keep each existing table
        when editing so reservations continue to refer to the same physical table.
      </Text>
      <Text style={op.text}>Latest version: {layouts[0]?.version ?? 0}</Text>
      <Field
        label="Floor plan name"
        value={value.name}
        onChange={(name) => setValue((v) => ({ ...v, name }))}
      />
      <FloorPreview layout={value} />
      <Text style={op.title}>Rooms and zones</Text>
      {value.zones.map((zone, index) => (
        <View key={zone.id}>
          <Field
            label="Zone name"
            value={zone.label}
            onChange={(label) =>
              setValue((v) => ({ ...v, zones: v.zones.map((x, i) => (i === index ? { ...x, label } : x)) }))
            }
          />
          <Button
            label="Remove empty zone"
            disabled={value.zones.length === 1 || value.tables.some((t) => t.zoneId === zone.id)}
            onPress={() => setValue((v) => ({ ...v, zones: v.zones.filter((z) => z.id !== zone.id) }))}
          />
        </View>
      ))}
      <Button
        label="Add zone"
        disabled={value.zones.length >= 30}
        onPress={() =>
          setValue((v) => ({ ...v, zones: [...v.zones, { id: Crypto.randomUUID(), label: 'New zone' }] }))
        }
      />
      <Text style={op.title}>Physical tables</Text>
      <View style={op.row}>
        {value.tables.map((t, index) => (
          <Button
            key={t.id ?? index}
            label={`${index === selected ? '✓ ' : ''}${t.label}`}
            onPress={() => setSelected(index)}
          />
        ))}
      </View>
      <Button
        label="Add a physical table"
        disabled={value.tables.length >= 200}
        onPress={() => {
          setSelected(value.tables.length);
          setValue((v) => ({
            ...v,
            tables: [
              ...v.tables,
              {
                label: `Table ${v.tables.length + 1}`,
                zoneId: v.zones[0]!.id,
                seats: 4,
                x: 0.5,
                y: 0.5,
                width: 0.15,
                height: 0.15,
                rotation: 0,
                shape: 'rectangle',
              },
            ],
          }));
        }}
      />
      {table ? (
        <View style={op.box}>
          <Field label="Table label" value={table.label} onChange={(label) => updateTable({ label })} />
          <Field
            label="Seats"
            value={String(table.seats)}
            onChange={(seats) => updateTable({ seats: Number(seats) })}
          />
          <View style={op.row}>
            {value.zones.map((z) => (
              <Button
                key={z.id}
                label={`${table.zoneId === z.id ? '✓ ' : ''}${z.label}`}
                onPress={() => updateTable({ zoneId: z.id })}
              />
            ))}
          </View>
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <Field
              key={key}
              label={`${key === 'x' ? 'Horizontal center' : key === 'y' ? 'Vertical center' : key} (% of floor plan)`}
              value={String(Math.round(table[key] * 10000) / 100)}
              onChange={(text) => updateTable({ [key]: Number(text) / 100 })}
            />
          ))}
          <Field
            label="Rotation (degrees)"
            value={String(table.rotation)}
            onChange={(rotation) => updateTable({ rotation: Number(rotation) })}
          />
          <View style={op.row}>
            {(['circle', 'rectangle'] as const).map((shape) => (
              <Button
                key={shape}
                label={`${table.shape === shape ? '✓ ' : ''}${shape}`}
                onPress={() => updateTable({ shape })}
              />
            ))}
          </View>
          <Button
            label="Remove table from this new plan"
            onPress={() => {
              setValue((v) => ({ ...v, tables: v.tables.filter((_, i) => i !== selected) }));
              setSelected(0);
            }}
          />
        </View>
      ) : null}
      <Field label="Reason for floor plan or block change" value={reason} onChange={setReason} />
      <Button
        label="Save new floor plan version"
        disabled={action.busy || !loaded}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/seller/venues/${encodeURIComponent(venue.id)}/layouts`, {
              ...value,
              expectedVersion: layouts[0]?.version ?? 0,
              reason,
            });
            await load();
            action.setMessage(
              'New floor plan saved. Select it in the event’s table inventory before creating offers.',
            );
          })
        }
      />
      {table?.id ? (
        <View style={op.box}>
          <Text style={op.title}>Block {table.label} from booking</Text>
          <Field
            label={`Block starts (${venue.timezone}, include offset)`}
            value={blockStart}
            onChange={(v) => {
              setBlockStart(v);
            }}
          />
          <Field
            label="Block ends (include offset)"
            value={blockEnd}
            onChange={(v) => {
              setBlockEnd(v);
            }}
          />
          <Button
            label="Create table block"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                const payload = JSON.stringify({
                  tableId: table.id,
                  startsAt: blockStart,
                  endsAt: blockEnd,
                  reason,
                });
                if (pendingBlock.current?.payload !== payload)
                  pendingBlock.current = { payload, key: Crypto.randomUUID() };
                await api.post(
                  `/v1/seller/tables/${table.id}/blocks`,
                  { startsAt: blockStart, endsAt: blockEnd, reason },
                  pendingBlock.current.key,
                );
                pendingBlock.current = null;
                await loadBlocks();
              })
            }
          />
        </View>
      ) : null}
      <Button
        label="Refresh table blocks"
        disabled={action.busy}
        onPress={() => void action.run(loadBlocks)}
      />
      {blocks.map((b) => (
        <View key={b.id}>
          <Text style={op.text}>
            {value.tables.find((t) => t.id === b.tableId)?.label ?? 'Table from an earlier plan'} ·{' '}
            {zonedInput(b.startsAt, venue.timezone)} – {zonedInput(b.endsAt, venue.timezone)} · {b.reason}
          </Text>
          <Button
            label="Release table block"
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/seller/table-blocks/${b.id}/release`, { reason });
                await loadBlocks();
              })
            }
          />
        </View>
      ))}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
export function TableOffers({
  data,
  onChanged,
}: {
  data: SellerInventoryData;
  onChanged: () => Promise<void>;
}) {
  const action = useAction(),
    [layouts, setLayouts] = useState<z.infer<typeof savedLayoutSchema>[]>([]),
    [layout, setLayout] = useState(''),
    [reason, setReason] = useState(''),
    [table, setTable] = useState(''),
    [start, setStart] = useState(zonedInput(data.occurrence.starts_at, data.occurrence.timezone)),
    [end, setEnd] = useState(zonedInput(data.occurrence.ends_at, data.occurrence.timezone)),
    [min, setMin] = useState('1'),
    [max, setMax] = useState('4'),
    [price, setPrice] = useState(''),
    [deposit, setDeposit] = useState(''),
    [tax, setTax] = useState('0'),
    [drinks, setDrinks] = useState('0'),
    [spend, setSpend] = useState('0'),
    [inclusions, setInclusions] = useState(''),
    [terms, setTerms] = useState(''),
    [minutes, setMinutes] = useState('30'),
    [active, setActive] = useState(false);
  useEffect(() => {
    void action.run(async () => {
      setLayouts(
        z
          .object({ data: z.array(savedLayoutSchema) })
          .parse(await api.request(`/v1/seller/venues/${encodeURIComponent(data.venueId)}/layouts`)).data,
      );
    });
  }, [data.venueId]);
  return (
    <View style={op.box}>
      <Text style={op.title}>Table offers</Text>
      <Field label="Reason for plan selection or offer publication" value={reason} onChange={setReason} />
      <Text style={op.text}>
        Choose a saved floor plan. The event’s plan cannot change after its first table offer is created.
      </Text>
      {layouts.map((l) => (
        <Button
          key={l.id}
          label={`${layout === l.id || (!layout && data.layout?.layout_id === l.id) ? '✓ ' : ''}${l.content.name} · version ${l.version}`}
          onPress={() => setLayout(l.id)}
        />
      ))}
      <Button
        label="Use selected plan for this event date"
        disabled={action.busy || !layout || data.tableOffers.length > 0}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/seller/occurrences/${data.occurrence.id}/layout`, {
              layoutId: layout,
              expectedVersion: data.layout?.version ?? 0,
              reason,
            });
            await onChanged();
            setTable('');
          })
        }
      />
      {data.layout ? (
        <>
          <FloorPreview layout={data.layout.content} />
          <View style={op.row}>
            {data.layout.content.tables.map((t) => (
              <Button
                key={t.id}
                label={`${table === t.id ? '✓ ' : ''}${t.label} · ${t.seats} seats`}
                onPress={() => {
                  setTable(t.id!);
                  setMax(String(t.seats));
                }}
              />
            ))}
          </View>
          <Field
            label={`Slot starts (${data.occurrence.timezone}, include offset)`}
            value={start}
            onChange={setStart}
          />
          <Field label="Slot ends (include offset)" value={end} onChange={setEnd} />
          <Field label="Minimum guests" value={min} onChange={setMin} />
          <Field label="Maximum guests" value={max} onChange={setMax} />
          <Field
            label={`Full price (${data.occurrence.currency}, includes tax)`}
            value={price}
            onChange={setPrice}
          />
          <Field
            label="Optional deposit amount (empty means full payment only)"
            value={deposit}
            onChange={setDeposit}
          />
          <Field label="Tax rate (%)" value={tax} onChange={setTax} />
          <Field label="Included drinks per guest" value={drinks} onChange={setDrinks} />
          <Field label="Minimum spend" value={spend} onChange={setSpend} />
          <Field label="What is included" value={inclusions} onChange={setInclusions} multiline />
          <Field label="Reservation terms" value={terms} onChange={setTerms} multiline />
          <Field
            label="Minutes after slot starts before marking no-show"
            value={minutes}
            onChange={setMinutes}
          />
          <Text style={op.text}>
            No-show policy: retain amounts already paid. Existing reservation terms and prices remain
            unchanged when a new offer is created.
          </Text>
          <Toggle label="Enable this table offer" value={active} onChange={setActive} />
          <Button
            label="Create table offer"
            disabled={action.busy || !table}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/seller/occurrences/${data.occurrence.id}/table-offers`, {
                  tableId: table,
                  slotStartsAt: start,
                  slotEndsAt: end,
                  minGuests: Number(min),
                  maxGuests: Number(max),
                  fullPriceMinor: decimalMinor(price),
                  depositMinor: deposit.trim() ? decimalMinor(deposit) : null,
                  taxBps: decimalMinor(tax),
                  drinksPerGuest: Number(drinks),
                  inclusions,
                  minimumSpendMinor: decimalMinor(spend),
                  terms,
                  noShowAfterMinutes: Number(minutes),
                  noShowPolicy: 'retain-paid',
                  active,
                });
                await onChanged();
                action.setMessage('Table offer created.');
              })
            }
          />
        </>
      ) : null}
      {data.tableOffers.map((o) => (
        <View key={o.id}>
          <Text style={op.text}>
            {data.layout?.content.tables.find((t) => t.id === o.table_id)?.label ?? 'Table'} ·{' '}
            {zonedInput(o.slot_starts_at, data.occurrence.timezone)} –{' '}
            {zonedInput(o.slot_ends_at, data.occurrence.timezone)} · {(o.full_price_minor / 100).toFixed(2)}{' '}
            {data.occurrence.currency} · {o.active ? 'active' : 'paused'}
          </Text>
          <Button
            label={o.active ? 'Pause this offer' : 'Enable this offer'}
            disabled={action.busy}
            onPress={() =>
              void action.run(async () => {
                await api.post(`/v1/seller/table-offers/${o.id}/publication`, {
                  active: !o.active,
                  expectedVersion: o.version,
                  reason,
                });
                await onChanged();
              })
            }
          />
        </View>
      ))}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

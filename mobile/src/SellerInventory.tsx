import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { z } from 'zod';
import { api } from './session';
import { Button, Field, Toggle, op, useAction } from './OperationsUI';
import {
  OccurrencePicker,
  occurrenceSchema,
  eventTime,
  zonedInput,
  type SellerOrganization,
  type Occurrence,
} from './SellerSelectors';
import { decimalMinor } from './SellerSelectors';
import { TableOffers, layoutSchema } from './SellerTables';
const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  admission_conditions: z.string(),
  price_minor: z.number(),
  tax_bps: z.number(),
  capacity: z.number(),
  drinks: z.number(),
  extra_drink_price_minor: z.number().nullable(),
  extra_drink_limit: z.number(),
  extra_drink_tax_bps: z.number(),
  sale_starts_at: z.string(),
  sale_ends_at: z.string(),
  active: z.boolean(),
  version: z.number(),
  committed: z.number(),
});
const inventorySchema = z.object({
  occurrence: occurrenceSchema,
  organizationId: z.string(),
  venueId: z.string(),
  hostOrganizationId: z.string().nullable(),
  products: z.array(productSchema),
  blocks: z.array(
    z.object({
      id: z.string(),
      quantity: z.number(),
      reason: z.string(),
      released_at: z.string().nullable(),
    }),
  ),
  layout: z.object({ layout_id: z.string(), version: z.number(), content: layoutSchema }).nullable(),
  tableOffers: z.array(
    z.object({
      id: z.string(),
      table_id: z.string(),
      slot_starts_at: z.string(),
      slot_ends_at: z.string(),
      full_price_minor: z.number(),
      deposit_minor: z.number().nullable(),
      min_guests: z.number(),
      max_guests: z.number(),
      version: z.number(),
      active: z.boolean(),
    }),
  ),
});
export type SellerInventoryData = z.infer<typeof inventorySchema>;
export function SellerInventory({ organization }: { organization: SellerOrganization }) {
  const [occurrence, setOccurrence] = useState<Occurrence | null>(null);
  return (
    <View style={op.box}>
      <Text style={op.title}>Tickets, capacity and tables</Text>
      <OccurrencePicker
        organizationId={organization.id}
        value={occurrence?.id ?? ''}
        onChange={setOccurrence}
      />
      {occurrence ? (
        <InventoryEditor key={occurrence.id} id={occurrence.id} organization={organization} />
      ) : null}
    </View>
  );
}
function InventoryEditor({ id, organization }: { id: string; organization: SellerOrganization }) {
  const action = useAction(),
    [data, setData] = useState<SellerInventoryData | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [capacity, setCapacity] = useState(''),
    [quantity, setQuantity] = useState(''),
    [reason, setReason] = useState(''),
    [revision, setRevision] = useState(0);
  async function load() {
    const result = z
      .object({ data: inventorySchema })
      .parse(await api.request(`/v1/seller/occurrences/${id}/inventory`));
    setData(result.data);
    setCapacity(String(result.data.occurrence.capacity));
    setRevision((v) => v + 1);
  }
  useEffect(() => {
    void action.run(load);
  }, [id]);
  return (
    <View style={{ gap: 12 }}>
      <Button label="Refresh inventory" disabled={action.busy} onPress={() => void action.run(load)} />
      {data ? (
        <>
          <Text style={op.text}>
            {eventTime(data.occurrence)} · {data.occurrence.currency} · total capacity{' '}
            {data.occurrence.capacity}
          </Text>
          {data.hostOrganizationId === organization.id &&
          organization.permissions.includes('event.publish') ? (
            <>
              <Field label="Event capacity" value={capacity} onChange={setCapacity} />
              <Field label="Reason for capacity or block changes" value={reason} onChange={setReason} />
              <Button
                label="Update attendance capacity"
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    if (!capacity.trim()) throw new Error('Enter a capacity.');
                    await api.post(`/v1/seller/occurrences/${id}/capacity`, {
                      capacity: Number(capacity),
                      expectedVersion: data.occurrence.version,
                      reason,
                    });
                    await load();
                  })
                }
              />
              <Field label="Admissions to block from sale" value={quantity} onChange={setQuantity} />
              <Button
                label="Block admissions"
                disabled={action.busy}
                onPress={() =>
                  void action.run(async () => {
                    await api.post(`/v1/seller/occurrences/${id}/blocks`, {
                      quantity: Number(quantity),
                      reason,
                    });
                    await load();
                  })
                }
              />
              {data.blocks
                .filter((b) => !b.released_at)
                .map((b) => (
                  <View key={b.id}>
                    <Text style={op.text}>
                      {b.quantity} admissions blocked: {b.reason}
                    </Text>
                    <Button
                      label="Release this block"
                      disabled={action.busy}
                      onPress={() =>
                        void action.run(async () => {
                          await api.post(`/v1/seller/occurrences/${id}/blocks`, {
                            releaseId: b.id,
                            quantity: b.quantity,
                            reason,
                          });
                          await load();
                        })
                      }
                    />
                  </View>
                ))}
            </>
          ) : null}
          <Text style={op.title}>Ticket types</Text>
          {data.products.map((p) => (
            <View key={p.id}>
              <Text style={op.text}>
                {p.name} · {(p.price_minor / 100).toFixed(2)} {data.occurrence.currency} · {p.committed}/
                {p.capacity} held or sold · {p.active ? 'active' : 'paused'}
              </Text>
              {data.organizationId === organization.id ? (
                <Button label={`Edit ${p.name}`} onPress={() => setSelected(p.id)} />
              ) : null}
            </View>
          ))}
          {data.organizationId === organization.id ? (
            <>
              <Button label="New ticket type" onPress={() => setSelected('new')} />
              {selected ? (
                <ProductForm
                  key={`${selected}:${revision}`}
                  occurrence={data.occurrence}
                  product={data.products.find((p) => p.id === selected)}
                  onSaved={async () => {
                    await load();
                    setSelected(null);
                  }}
                />
              ) : null}
            </>
          ) : (
            <Text style={op.text}>Ticket pricing is managed by the event’s selling organization.</Text>
          )}
          {data.hostOrganizationId === organization.id &&
          organization.permissions.includes('event.publish') ? (
            <TableOffers data={data} onChanged={load} />
          ) : null}
        </>
      ) : null}
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}
function ProductForm({
  occurrence: o,
  product: p,
  onSaved,
}: {
  occurrence: Occurrence;
  product?: z.infer<typeof productSchema>;
  onSaved: () => Promise<void>;
}) {
  const action = useAction(),
    [name, setName] = useState(p?.name ?? ''),
    [conditions, setConditions] = useState(p?.admission_conditions ?? ''),
    [price, setPrice] = useState(p ? (p.price_minor / 100).toFixed(2) : ''),
    [tax, setTax] = useState(String((p?.tax_bps ?? 0) / 100)),
    [capacity, setCapacity] = useState(String(p?.capacity ?? o.capacity)),
    [drinks, setDrinks] = useState(String(p?.drinks ?? 0)),
    [extraPrice, setExtraPrice] = useState(
      p?.extra_drink_price_minor != null ? (p.extra_drink_price_minor / 100).toFixed(2) : '',
    ),
    [extraLimit, setExtraLimit] = useState(String(p?.extra_drink_limit ?? 0)),
    [extraTax, setExtraTax] = useState(String((p?.extra_drink_tax_bps ?? 0) / 100)),
    [startsAt, setStart] = useState(zonedInput(p?.sale_starts_at ?? new Date().toISOString(), o.timezone)),
    [endsAt, setEnd] = useState(zonedInput(p?.sale_ends_at ?? o.starts_at, o.timezone)),
    [active, setActive] = useState(p?.active ?? false);
  return (
    <View style={op.box}>
      <Text style={op.title}>{p ? 'Edit ticket type' : 'New ticket type'}</Text>
      <Field label="Ticket name" value={name} onChange={setName} />
      <Field label="Admission conditions" value={conditions} onChange={setConditions} multiline />
      <Field label={`Price (${o.currency}, includes tax)`} value={price} onChange={setPrice} />
      <Field label="Tax rate (%)" value={tax} onChange={setTax} />
      <Field label="Ticket capacity" value={capacity} onChange={setCapacity} />
      <Field label="Included drink vouchers" value={drinks} onChange={setDrinks} />
      <Field
        label={`Extra drink price (${o.currency}, optional)`}
        value={extraPrice}
        onChange={setExtraPrice}
      />
      <Field label="Maximum extra drinks per ticket" value={extraLimit} onChange={setExtraLimit} />
      <Field label="Extra drink tax rate (%)" value={extraTax} onChange={setExtraTax} />
      <Field label="Sales start (include UTC offset)" value={startsAt} onChange={setStart} />
      <Field label="Sales end (include UTC offset)" value={endsAt} onChange={setEnd} />
      <Toggle label="Enable sales for this ticket type" value={active} onChange={setActive} />
      <Button
        label="Save ticket type"
        disabled={action.busy}
        onPress={() =>
          void action.run(async () => {
            await api.post(`/v1/seller/occurrences/${o.id}/products${p ? `/${p.id}` : ''}`, {
              name,
              admissionConditions: conditions,
              priceMinor: decimalMinor(price),
              taxBps: decimalMinor(tax),
              capacity: Number(capacity),
              drinks: Number(drinks),
              extraDrinkPriceMinor: extraPrice.trim() ? decimalMinor(extraPrice) : null,
              extraDrinkLimit: Number(extraLimit),
              extraDrinkTaxBps: decimalMinor(extraTax),
              saleStartsAt: startsAt,
              saleEndsAt: endsAt,
              active,
              ...(p ? { expectedVersion: p.version } : {}),
            });
            await onSaved();
          })
        }
      />
      <Text style={op.text} accessibilityRole="alert">
        {action.message}
      </Text>
    </View>
  );
}

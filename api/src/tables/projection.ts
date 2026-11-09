/** Buyer-safe reservation projection; legal terms and pricing remain their purchased snapshot. */
export function tableProjection(row: any) {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    status: row.status as string,
    currency: row.currency as string,
    guests: Number(row.guests),
    snapshot: row.snapshot,
    fullPriceMinor: Number(row.full_price_minor),
    onlineAmountMinor: Number(row.online_amount_minor),
    doorCollectedMinor: Number(row.door_collected_minor),
    balanceDueMinor: ['held', 'confirmed'].includes(row.status)
      ? row.full_price_minor - row.online_amount_minor - row.door_collected_minor
      : 0,
    doorRefundDueMinor: row.status === 'refund-review' ? Number(row.door_collected_minor) : 0,
  };
}

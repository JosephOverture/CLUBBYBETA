import { z } from 'zod';
import { isIP } from 'node:net';
import { idSchema } from '@clubby/contracts';

export function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      host.includes('.') &&
      !isIP(host.replace(/^\[|\]$/g, '')) &&
      !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
    );
  } catch {
    return false;
  }
}
export const externalUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(safeExternalUrl, 'A public HTTPS booking URL is required.');
export const timezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA timezone.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const interval = z.object({ opens: time, closes: time }).strict();
export const scheduleSchema = z
  .object({
    weekly: z
      .array(z.object({ day: z.number().int().min(0).max(6), intervals: z.array(interval).max(4) }).strict())
      .max(7),
    exceptions: z
      .array(z.object({ date: z.iso.date(), intervals: z.array(interval).max(4) }).strict())
      .max(366),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.weekly.map((v) => v.day)).size === value.weekly.length &&
      new Set(value.exceptions.map((v) => v.date)).size === value.exceptions.length,
    'Schedule days must be unique.',
  );
export const venueInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(10_000),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    tags: z.array(z.string().trim().min(1).max(50)).max(30),
    minimumAge: z.number().int().min(0).max(99),
    address: z.string().trim().max(500),
    contactUrl: externalUrlSchema.nullable(),
    schedule: scheduleSchema,
  })
  .strict();
export const createVenueInput = venueInput.extend({
  id: idSchema,
  organizationId: z.string().uuid(),
  destinationId: idSchema,
});
export const eventInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10_000),
    lineup: z.array(z.string().trim().min(1).max(160)).max(100),
    tags: z.array(z.string().trim().min(1).max(50)).max(30),
    externalUrl: externalUrlSchema.nullable().default(null),
    occurrences: z
      .array(
        z
          .object({
            startsAt: z.iso.datetime({ offset: true }),
            endsAt: z.iso.datetime({ offset: true }),
            capacity: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const versionedReason = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(5).max(1000),
});
export function validZonedInstant(value: string, timezone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return false;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return ['year', 'month', 'day', 'hour', 'minute'].every(
    (key, i) => parts.find((p) => p.type === key)?.value === match[i + 1],
  );
}
export function openAt(schedule: z.infer<typeof scheduleSchema>, timezone: string, instant: Date) {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => dateParts.find((p) => p.type === type)!.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`,
    minutes = Number(part('hour')) * 60 + Number(part('minute'));
  const calendar = new Date(`${date}T12:00:00Z`),
    weekday = calendar.getUTCDay();
  const previous = new Date(calendar.getTime() - 86400_000).toISOString().slice(0, 10);
  const intervals = (day: string, index: number) =>
    schedule.exceptions.find((v) => v.date === day)?.intervals ??
    schedule.weekly.find((v) => v.day === index)?.intervals ??
    [];
  const toMinutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  if (
    intervals(date, weekday).some((v) => {
      const start = toMinutes(v.opens),
        end = toMinutes(v.closes);
      return end > start ? minutes >= start && minutes < end : minutes >= start;
    })
  )
    return true;
  // An explicit exception for today also controls the overnight carry-in (an empty day means closed).
  if (schedule.exceptions.some((v) => v.date === date)) return false;
  return intervals(previous, (weekday + 6) % 7).some(
    (v) => toMinutes(v.closes) <= toMinutes(v.opens) && minutes < toMinutes(v.closes),
  );
}

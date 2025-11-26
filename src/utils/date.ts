import { DateTime } from "luxon";

export const JAKARTA_TZ = "Asia/Jakarta";

// waktu sekarang di zona Jakarta, atau pakai transactedAt kalau dikirim
export function nowJkt(transactedAt?: string) {
  return transactedAt
    ? DateTime.fromISO(transactedAt, { zone: JAKARTA_TZ })
    : DateTime.now().setZone(JAKARTA_TZ);
}

export function toDayKey(dt: any): string {
  // dt diharapkan DateTime, tapi kita pakai any biar TS nggak rewel
  return dt.toISODate();
}

export function addDays(dateStr: string | null, days: number): string {
  const base = dateStr
    ? DateTime.fromISO(dateStr, { zone: JAKARTA_TZ })
    : DateTime.now().setZone(JAKARTA_TZ);

  return base.plus({ days }).toISODate();
}

export function firstDayOfNextMonth(dt: any): string {
  // dt diharapkan DateTime
  return dt.plus({ months: 1 }).startOf("month").toISODate();
}

export function isMembershipActive(
  membershipEndAt: string | null,
  at: any
): boolean {
  if (!membershipEndAt) return false;
  const endDate = DateTime.fromISO(membershipEndAt, { zone: JAKARTA_TZ }).endOf(
    "day"
  );
  return endDate >= at;
}

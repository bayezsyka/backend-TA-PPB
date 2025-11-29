// src/services/cashbackService.ts
import { supabase } from "../supabaseClient";
import { firstDayOfNextMonth } from "../utils/date";

export async function getUsableCashbackBalance(memberId: string, at: any) {
  const today = at.toISODate();

  // cashback yang sudah aktif (usable_from <= hari ini)
  const { data: earns, error: earnsError } = await supabase
    .from("cashback_ledger")
    .select("amount")
    .eq("member_id", memberId)
    .eq("entry_type", "earn")
    .lte("usable_from", today);

  if (earnsError) throw earnsError;

  // semua spend/adjust (negatif)
  const { data: spends, error: spendsError } = await supabase
    .from("cashback_ledger")
    .select("amount")
    .eq("member_id", memberId)
    .in("entry_type", ["spend", "adjust"]);

  if (spendsError) throw spendsError;

  const totalEarn = (earns || []).reduce(
    (sum, r: any) => sum + (r.amount || 0),
    0
  );
  const totalSpend = (spends || []).reduce(
    (sum, r: any) => sum + (r.amount || 0),
    0
  );

  return totalEarn + totalSpend;
}

export async function getPendingCashbackBalance(memberId: string, at: any) {
  const today = at.toISODate();

  // cashback yang SUDAH di-earn tapi usable_from-nya MASIH DI DEPAN (bulan depan dst)
  const { data: earns, error } = await supabase
    .from("cashback_ledger")
    .select("amount")
    .eq("member_id", memberId)
    .eq("entry_type", "earn")
    .gt("usable_from", today);

  if (error) throw error;

  const totalEarn = (earns || []).reduce(
    (sum, r: any) => sum + (r.amount || 0),
    0
  );

  return totalEarn;
}

export async function calculateCashbackForTransaction(params: {
  memberId: string;
  paidCash: number;
  at: any;
}) {
  const { memberId, paidCash, at } = params;

  if (paidCash < 15000) {
    return { earned: 0, detail: [] as any[] };
  }

  const MULTIPLE = 15000;
  const PER_MULTIPLE_CB = 2500;
  const DAILY_MAX = 5000;

  // cek dulu hari ini sudah dapat cashback berapa
  const dayKey = at.toISODate();
  const dayStart = at.startOf("day").toISO();
  const dayEnd = at.endOf("day").toISO();

  const { data: rows, error } = await supabase
    .from("transactions")
    .select("paid_cash, cashback_earned")
    .eq("member_id", memberId)
    .gte("transacted_at", dayStart)
    .lte("transacted_at", dayEnd);

  if (error) throw error;

  const prevCashPaid = (rows || []).reduce(
    (sum, r: any) => sum + (r.paid_cash || 0),
    0
  );
  const prevEarned = (rows || []).reduce(
    (sum, r: any) => sum + (r.cashback_earned || 0),
    0
  );

  const todayCashPaid = prevCashPaid + paidCash;

  const multiples = Math.floor(todayCashPaid / MULTIPLE);
  const theoreticalEarn = multiples * PER_MULTIPLE_CB;

  let earned = theoreticalEarn - prevEarned;
  if (earned < 0) {
    earned = 0;
  }

  const remainingLimit = DAILY_MAX - prevEarned;
  if (remainingLimit <= 0) {
    earned = 0;
  } else if (earned > remainingLimit) {
    earned = remainingLimit;
  }

  if (earned < 0) earned = 0;

  return {
    earned,
    detail: [
      {
        rule: "15k-per-multiple",
        multiples,
        dailyLimit: DAILY_MAX,
        prevEarned,
        finalEarned: earned,
        dayKey,
      },
    ],
  };
}

export async function addCashbackEarnEntry(params: {
  memberId: string;
  transactionId: string;
  earned: number;
  at: any;
}) {
  const { memberId, transactionId, earned, at } = params;
  if (earned <= 0) return;

  const usableFrom = firstDayOfNextMonth(at);

  const { error } = await supabase.from("cashback_ledger").insert({
    member_id: memberId,
    transaction_id: transactionId,
    entry_type: "earn",
    amount: earned,
    usable_from: usableFrom,
    description: "Cashback earned from transaction",
  });

  if (error) throw error;
}

export async function addCashbackSpendEntry(params: {
  memberId: string;
  transactionId: string;
  spent: number;
}) {
  const { memberId, transactionId, spent } = params;
  if (spent <= 0) return;

  const { error } = await supabase.from("cashback_ledger").insert({
    member_id: memberId,
    transaction_id: transactionId,
    entry_type: "spend",
    amount: -spent,
    description: "Cashback spent on transaction",
  });

  if (error) throw error;
}

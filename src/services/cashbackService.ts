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

export async function calculateCashbackForTransaction(params: {
  memberId: string;
  paidCash: number;
  at: any;
}) {
  const { memberId, paidCash, at } = params;
  if (paidCash <= 0) return { earned: 0 };

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
  const prevCashbackEarned = (rows || []).reduce(
    (sum, r: any) => sum + (r.cashback_earned || 0),
    0
  );

  const newTotalCash = prevCashPaid + paidCash;

  // Aturan:
  // tiap 15.000 → 2.500, minimal 15.000, maksimal 5.000 per hari
  const step = 15000;
  const rewardPerStep = 2500;
  const maxDaily = 5000;

  const unitCount = Math.floor(newTotalCash / step);
  const possibleTotal = Math.min(unitCount * rewardPerStep, maxDaily);

  const earnedNow = Math.max(0, possibleTotal - prevCashbackEarned);

  return { earned: earnedNow };
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

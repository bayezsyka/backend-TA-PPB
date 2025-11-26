// src/routes/transactions.ts
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../supabaseClient";
import { nowJkt, toDayKey, isMembershipActive } from "../utils/date";
import {
  calculateCashbackForTransaction,
  addCashbackEarnEntry,
  addCashbackSpendEntry,
  getUsableCashbackBalance,
} from "../services/cashbackService";

const router = Router();

const CreateTransactionSchema = z.object({
  memberId: z.string().uuid(),
  totalAmount: z.number().int().positive(),
  paymentType: z.enum(["cash", "cashback"]),
  cashbackToUse: z.number().int().min(0).default(0),
  transactedAt: z.string().datetime().optional(),
});

// POST /transactions
router.post("/", async (req, res) => {
  try {
    const parsed = CreateTransactionSchema.parse(req.body);
    const dt = nowJkt(parsed.transactedAt);
    const dayKey = toDayKey(dt);

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("*")
      .eq("id", parsed.memberId)
      .single();

    if (memberError || !member) {
      return res.status(404).json({ message: "Member not found" });
    }

    const membershipActive = isMembershipActive(member.membership_end_at, dt);

    if (parsed.paymentType === "cashback" && !membershipActive) {
      return res.status(400).json({
        message:
          "Membership tidak aktif. Cashback hanya bisa dipakai oleh member aktif.",
      });
    }

    let paidCashback = 0;
    let paidCash = 0;

    if (parsed.paymentType === "cash") {
      paidCash = parsed.totalAmount;
    } else {
      const usableBalance = await getUsableCashbackBalance(parsed.memberId, dt);

      if (parsed.cashbackToUse <= 0) {
        return res.status(400).json({
          message: "cashbackToUse harus > 0 untuk pembayaran cashback",
        });
      }

      if (parsed.cashbackToUse > parsed.totalAmount) {
        return res.status(400).json({
          message:
            "Cashback yang dipakai tidak boleh lebih besar dari total belanja",
        });
      }

      if (parsed.cashbackToUse > usableBalance) {
        return res.status(400).json({
          message:
            "Cashback yang dipakai melebihi saldo yang bisa digunakan saat ini",
        });
      }

      paidCashback = parsed.cashbackToUse;
      paidCash = parsed.totalAmount - paidCashback;
    }

    let cashbackEarned = 0;
    if (membershipActive && paidCash > 0) {
      const { earned } = await calculateCashbackForTransaction({
        memberId: parsed.memberId,
        paidCash,
        at: dt,
      });
      cashbackEarned = earned;
    }

    const { data: trx, error: trxError } = await supabase
      .from("transactions")
      .insert({
        member_id: parsed.memberId,
        transacted_at: dt.toISO(),
        day_key: dayKey,
        total_amount: parsed.totalAmount,
        paid_cash: paidCash,
        paid_cashback: paidCashback,
        cashback_earned: cashbackEarned,
        cashback_spent: paidCashback,
      })
      .select()
      .single();

    if (trxError) throw trxError;

    if (cashbackEarned > 0) {
      await addCashbackEarnEntry({
        memberId: parsed.memberId,
        transactionId: trx.id,
        earned: cashbackEarned,
        at: dt,
      });
    }

    if (paidCashback > 0) {
      await addCashbackSpendEntry({
        memberId: parsed.memberId,
        transactionId: trx.id,
        spent: paidCashback,
      });
    }

    res.status(201).json({
      id: trx.id,
      memberId: parsed.memberId,
      totalAmount: parsed.totalAmount,
      paidCash,
      paidCashback,
      cashbackEarned,
      cashbackSpent: paidCashback,
      membershipActive,
    });
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res.status(500).json({ message: "Error creating transaction" });
  }
});

// GET /transactions?memberId=...&limit=...
router.get("/", async (req, res) => {
  try {
    const memberId = req.query.memberId as string | undefined;
    const limit = Number(req.query.limit || 50);

    let query = supabase
      .from("transactions")
      .select("*, members(name, whatsapp)")
      .order("transacted_at", { ascending: false })
      .limit(limit);

    if (memberId) {
      query = query.eq("member_id", memberId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const result = (data || []).map((row: any) => ({
      id: row.id,
      memberId: row.member_id,
      memberName: row.members?.name,
      memberWhatsapp: row.members?.whatsapp,
      transactedAt: row.transacted_at,
      totalAmount: row.total_amount,
      cashbackEarned: row.cashback_earned,
      cashbackSpent: row.cashback_spent,
    }));

    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ message: "Error fetching transactions" });
  }
});

export default router;

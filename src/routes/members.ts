// src/routes/members.ts
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../supabaseClient";
import { nowJkt, isMembershipActive } from "../utils/date";
import { getUsableCashbackBalance } from "../services/cashbackService";

const router = Router();

/**
 * Helper: mapping row members -> response standar
 */
function mapMemberRow(row: any) {
  const at = nowJkt();
  const active = isMembershipActive(row.membership_end_at, at);

  return {
    id: row.id as string,
    name: row.name as string,
    whatsapp: row.whatsapp as string,
    membershipEndAt: row.membership_end_at as string | null,
    isActive: active,
  };
}

/**
 * Schema request
 */
const CreateMemberSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  whatsapp: z.string().min(5, "Nomor WhatsApp terlalu pendek"),
});

const UpdateMemberSchema = z
  .object({
    name: z.string().min(1).optional(),
    whatsapp: z.string().min(5).optional(),
  })
  .refine((data) => data.name || data.whatsapp, {
    message: "Minimal salah satu dari nama atau whatsapp harus diisi",
  });

const PayMembershipSchema = z.object({
  amount: z.number().int().positive().default(35000),
  paidAt: z.string().datetime().optional(),
});

/**
 * GET /members
 * List member untuk tab Member & Pembayaran
 */
router.get("/", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("members")
      .select("*")
      .order("name", { ascending: true });

    if (error) throw error;

    const result = (data || []).map(mapMemberRow);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching members" });
  }
});

/**
 * POST /members
 * Tambah member baru
 */
router.post("/", async (req, res) => {
  try {
    const parsed = CreateMemberSchema.parse(req.body);

    const { data, error } = await supabase
      .from("members")
      .insert({
        name: parsed.name,
        whatsapp: parsed.whatsapp,
        membership_end_at: null,
      })
      .select("*")
      .single();

    if (error) throw error;

    res.status(201).json(mapMemberRow(data));
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res.status(500).json({ message: "Error creating member" });
  }
});

/**
 * PUT /members/:id
 * Update nama / whatsapp member
 */
router.put("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const parsed = UpdateMemberSchema.parse(req.body);

    const { data, error } = await supabase
      .from("members")
      .update(parsed)
      .eq("id", memberId)
      .select("*")
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.json(mapMemberRow(data));
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res.status(500).json({ message: "Error updating member" });
  }
});

/**
 * DELETE /members/:id
 * Hapus member (saat ini hard delete; bisa diganti soft delete nanti)
 */
router.delete("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { error } = await supabase
      .from("members")
      .delete()
      .eq("id", memberId);
    if (error) throw error;

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error deleting member" });
  }
});

/**
 * GET /members/:id/detail
 * Dipakai popup detail (tab Member & Pembayaran)
 */
router.get("/:id/detail", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("*")
      .eq("id", memberId)
      .single();

    if (memberError) throw memberError;
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    const at = nowJkt();
    const isActive = isMembershipActive(member.membership_end_at, at);
    const usableCashback = await getUsableCashbackBalance(memberId, at);

    // cek apakah ada pembayaran membership (buat tombol undo di frontend)
    const { data: payments, error: paymentsError } = await supabase
      .from("membership_payments")
      .select("id")
      .eq("member_id", memberId)
      .limit(1);

    if (paymentsError) throw paymentsError;

    const canUndoLastPayment = !!(payments && payments.length > 0);

    res.json({
      id: member.id,
      name: member.name,
      whatsapp: member.whatsapp,
      membershipEndAt: member.membership_end_at,
      isActive,
      usableCashback,
      canUndoLastPayment,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching member detail" });
  }
});

/**
 * POST /members/:id/membership/pay
 * Konfirmasi bayar membership (perpanjang 30 hari)
 */
router.post("/:id/membership/pay", async (req, res) => {
  const memberId = req.params.id;

  try {
    const parsed = PayMembershipSchema.parse(req.body);
    const paidAt = nowJkt(parsed.paidAt);

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("id, membership_end_at")
      .eq("id", memberId)
      .single();

    if (memberError) throw memberError;
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    // Hitung base date perpanjangan
    const currentlyActive = isMembershipActive(
      member.membership_end_at,
      paidAt
    );
    const currentEnd = member.membership_end_at
      ? paidAt
          .set({
            year: paidAt.year,
          })
          .set({}) && member.membership_end_at
      : null;

    // Kalau masih aktif, perpanjangan dari tanggal end lama; kalau tidak, dari sekarang
    const baseDate =
      currentlyActive && member.membership_end_at
        ? paidAt.set({
            year: paidAt.year,
          }) && paidAt // kita pakai paidAt; isMembershipActive sudah pakai end lama untuk status
        : paidAt;

    // Sederhanakan: newEnd = (membership_end_at jika masih aktif, else paidAt) + 30 hari
    const newEnd = (() => {
      if (member.membership_end_at && currentlyActive) {
        const prevEnd = nowJkt(member.membership_end_at);
        return prevEnd.plus({ days: 30 });
      }
      return paidAt.plus({ days: 30 });
    })();

    // simpan riwayat pembayaran
    const { error: payError } = await supabase
      .from("membership_payments")
      .insert({
        member_id: memberId,
        amount: parsed.amount,
        previous_end_at: member.membership_end_at,
        new_end_at: newEnd.toISODate(),
        paid_at: paidAt.toISO(),
      });

    if (payError) throw payError;

    // update membership_end_at pada members
    const { error: updateError } = await supabase
      .from("members")
      .update({ membership_end_at: newEnd.toISODate() })
      .eq("id", memberId);

    if (updateError) throw updateError;

    res.json({
      memberId,
      membershipEndAt: newEnd.toISODate(),
    });
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res.status(500).json({ message: "Error updating membership" });
  }
});

/**
 * POST /members/:id/membership/undo-last-payment
 * Batalkan pembayaran membership terakhir
 */
router.post("/:id/membership/undo-last-payment", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { data: payments, error: paymentsError } = await supabase
      .from("membership_payments")
      .select("id, new_end_at")
      .eq("member_id", memberId)
      .order("paid_at", { ascending: false })
      .limit(2);

    if (paymentsError) throw paymentsError;

    if (!payments || payments.length === 0) {
      return res.status(400).json({
        message: "Tidak ada pembayaran membership untuk dibatalkan.",
      });
    }

    const lastPayment = payments[0];

    // hapus pembayaran terakhir
    const { error: deleteError } = await supabase
      .from("membership_payments")
      .delete()
      .eq("id", lastPayment.id);

    if (deleteError) throw deleteError;

    // membership_end_at dikembalikan ke pembayaran sebelumnya (kalau ada), atau null
    const prevEndAt = payments.length > 1 ? payments[1].new_end_at : null;

    const { error: updateError } = await supabase
      .from("members")
      .update({ membership_end_at: prevEndAt })
      .eq("id", memberId);

    if (updateError) throw updateError;

    res.json({
      memberId,
      membershipEndAt: prevEndAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error undoing last membership payment" });
  }
});

export default router;

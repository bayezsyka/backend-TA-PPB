// src/routes/members.ts
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../supabaseClient";
import { nowJkt, isMembershipActive } from "../utils/date";

const router = Router();

// ===== Schemas =====
const CreateMemberSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  whatsapp: z.string().min(5, "Nomor WhatsApp terlalu pendek"),
});

const UpdateMemberSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  whatsapp: z.string().min(5, "Nomor WhatsApp terlalu pendek"),
});

// ===== Helpers =====

function normalizeWhatsapp(raw: string): string {
  let v = raw.trim();
  if (!v) return v;

  // buang spasi
  v = v.replace(/\s+/g, "");

  // kalau diawali 0 -> ganti ke 62
  if (v.startsWith("0")) {
    v = "62" + v.slice(1);
  }

  // kalau diawali + -> buang +
  if (v.startsWith("+")) {
    v = v.slice(1);
  }

  return v;
}

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  // ambil YYYY-MM-DD saja, biar simple
  return dateStr.slice(0, 10);
}

function mapMemberRow(row: any) {
  const now = nowJkt();
  const active = isMembershipActive(row.membership_end_at, now);

  return {
    id: row.id,
    name: row.name,
    whatsapp: row.whatsapp,
    membershipEndAt: formatDate(row.membership_end_at),
    isActive: active,
  };
}

async function getCashbackSummary(memberId: string) {
  const now = nowJkt();
  const today = now.toISODate()!; // YYYY-MM-DD

  const { data, error } = await supabase
    .from("cashback_ledger")
    .select("entry_type, amount, usable_from")
    .eq("member_id", memberId);

  if (error) {
    console.error("Error fetching cashback_ledger:", error);
    throw new Error("Gagal mengambil data cashback member.");
  }

  let usableCashback = 0;
  let pendingCashback = 0;

  for (const row of data ?? []) {
    const amt = row.amount || 0;
    const usableFrom: string | null = row.usable_from;

    if (row.entry_type === "earn") {
      if (usableFrom && usableFrom <= today) {
        usableCashback += amt;
      } else {
        pendingCashback += amt;
      }
    } else if (row.entry_type === "spend") {
      usableCashback -= amt;
    }
  }

  if (usableCashback < 0) usableCashback = 0;

  return { usableCashback, pendingCashback };
}

async function getCanUndoLastPayment(memberId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("membership_payments")
    .select("id")
    .eq("member_id", memberId)
    .order("paid_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error checking membership_payments:", error);
    return false;
  }

  return (data ?? []).length > 0;
}

// ===== Routes =====

/**
 * GET /members
 * List member aktif (tidak diarsipkan)
 */
router.get("/", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("members")
      .select("*")
      .eq("is_archived", false)
      .order("membership_end_at", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw error;

    const result = (data ?? []).map(mapMemberRow);
    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ message: "Gagal mengambil daftar member." });
  }
});

/**
 * POST /members
 * Buat member baru
 */
router.post("/", async (req, res) => {
  try {
    const parsed = CreateMemberSchema.parse(req.body);
    const normalizedWa = normalizeWhatsapp(parsed.whatsapp);

    const insertData = {
      name: parsed.name.trim(),
      whatsapp: normalizedWa,
      is_archived: false,
    };

    const { data, error } = await supabase
      .from("members")
      .insert(insertData)
      .select("*")
      .single();

    if (error) {
      console.error("Error inserting member:", error);
      // handle duplicate nomor WA
      if (
        (error as any).code === "23505" ||
        (error as any).message?.toLowerCase().includes("duplicate")
      ) {
        return res.status(400).json({
          message: "Nomor WhatsApp sudah terdaftar sebagai member.",
        });
      }
      throw error;
    }

    res.status(201).json(mapMemberRow(data));
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Body tidak valid.", details: err.issues });
    }
    res.status(500).json({ message: "Error creating member" });
  }
});

/**
 * PUT /members/:id
 * Update nama / whatsapp member (full update)
 */
router.put("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const parsed = UpdateMemberSchema.parse(req.body);
    const normalizedWa = normalizeWhatsapp(parsed.whatsapp);

    const updateData = {
      name: parsed.name.trim(),
      whatsapp: normalizedWa,
    };

    const { data, error } = await supabase
      .from("members")
      .update(updateData)
      .eq("id", memberId)
      .select("*")
      .single();

    if (error) {
      console.error("Error updating member (PUT):", error);
      if (
        (error as any).code === "23505" ||
        (error as any).message?.toLowerCase().includes("duplicate")
      ) {
        return res.status(400).json({
          message: "Nomor WhatsApp sudah terdaftar sebagai member.",
        });
      }
      throw error;
    }

    if (!data) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.json(mapMemberRow(data));
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Body tidak valid.", details: err.issues });
    }
    res.status(500).json({ message: "Error updating member" });
  }
});

/**
 * PATCH /members/:id
 * Sama seperti PUT, dipakai frontend untuk update member (partial)
 */
router.patch("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const parsed = UpdateMemberSchema.parse(req.body);
    const normalizedWa = normalizeWhatsapp(parsed.whatsapp);

    const updateData = {
      name: parsed.name.trim(),
      whatsapp: normalizedWa,
    };

    const { data, error } = await supabase
      .from("members")
      .update(updateData)
      .eq("id", memberId)
      .select("*")
      .single();

    if (error) {
      console.error("Error updating member (PATCH):", error);
      if (
        (error as any).code === "23505" ||
        (error as any).message?.toLowerCase().includes("duplicate")
      ) {
        return res.status(400).json({
          message: "Nomor WhatsApp sudah terdaftar sebagai member.",
        });
      }
      throw error;
    }

    if (!data) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.json(mapMemberRow(data));
  } catch (err: any) {
    console.error(err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Body tidak valid.", details: err.issues });
    }
    res.status(500).json({ message: "Error updating member" });
  }
});

/**
 * DELETE /members/:id
 * Soft delete (arsip) member
 */
router.delete("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { data, error } = await supabase
      .from("members")
      .update({ is_archived: true })
      .eq("id", memberId)
      .select("*")
      .single();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.json({ message: "Member diarsipkan." });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ message: "Error deleting member" });
  }
});

/**
 * GET /members/:id/detail
 * Detail member + info cashback
 */
router.get("/:id/detail", async (req, res) => {
  const memberId = req.params.id;

  try {
    const now = nowJkt();

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("*")
      .eq("id", memberId)
      .single();

    if (memberError || !member) {
      console.error("Error fetching member detail:", memberError);
      return res.status(404).json({ message: "Member not found" });
    }

    const { usableCashback, pendingCashback } = await getCashbackSummary(
      memberId
    );

    const canUndoLastPayment = await getCanUndoLastPayment(memberId);

    const active = isMembershipActive(member.membership_end_at, now);

    res.json({
      id: member.id,
      name: member.name,
      whatsapp: member.whatsapp,
      membershipEndAt: formatDate(member.membership_end_at),
      isActive: active,
      usableCashback,
      pendingCashback,
      canUndoLastPayment,
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ message: "Terjadi kesalahan server." });
  }
});

/**
 * POST /members/:id/membership/pay
 * Konfirmasi bayar membership (perpanjang 30 hari)
 * Body: { amount?: number } -> default 35000
 */
router.post("/:id/membership/pay", async (req, res) => {
  const memberId = req.params.id;

  try {
    const amount: number = req.body?.amount ?? 35000;
    const nowDate = new Date();

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("*")
      .eq("id", memberId)
      .single();

    if (memberError || !member) {
      console.error("Error fetching member for pay:", memberError);
      return res.status(404).json({ message: "Member not found" });
    }

    const currentEnd = member.membership_end_at
      ? new Date(member.membership_end_at)
      : null;

    let baseDate = nowDate;
    if (currentEnd && currentEnd > nowDate) {
      baseDate = currentEnd;
    }

    const newEndDate = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const newEndIso = newEndDate.toISOString();

    // catat ke tabel membership_payments
    const { error: payError } = await supabase
      .from("membership_payments")
      .insert({
        member_id: memberId,
        amount,
        paid_at: nowDate.toISOString(),
        period_start: baseDate.toISOString(),
        period_end: newEndIso,
      });

    if (payError) {
      console.error("Error inserting membership_payments:", payError);
      throw payError;
    }

    const { data: updatedMember, error: updateError } = await supabase
      .from("members")
      .update({ membership_end_at: newEndIso })
      .eq("id", memberId)
      .select("*")
      .single();

    if (updateError) throw updateError;

    const now = nowJkt();
    const active = isMembershipActive(updatedMember.membership_end_at, now);

    res.json({
      id: updatedMember.id,
      membershipEndAt: formatDate(updatedMember.membership_end_at),
      isActive: active,
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ message: "Gagal memproses pembayaran membership." });
  }
});

/**
 * POST /members/:id/membership/undo-last-payment
 * Batalkan pembayaran membership terakhir
 */
router.post("/:id/membership/undo-last-payment", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { data: payments, error: payError } = await supabase
      .from("membership_payments")
      .select("*")
      .eq("member_id", memberId)
      .order("paid_at", { ascending: false })
      .limit(2);

    if (payError) {
      console.error("Error fetching membership_payments:", payError);
      throw payError;
    }

    if (!payments || payments.length === 0) {
      return res.status(400).json({
        message: "Tidak ada pembayaran membership untuk dibatalkan.",
      });
    }

    const lastPayment = payments[0];
    const previousPayment = payments[1];

    // hapus pembayaran terakhir
    const { error: delError } = await supabase
      .from("membership_payments")
      .delete()
      .eq("id", lastPayment.id);

    if (delError) {
      console.error("Error deleting last membership_payment:", delError);
      throw delError;
    }

    let newEnd: string | null = null;
    if (previousPayment) {
      newEnd = previousPayment.period_end;
    }

    const { data: updatedMember, error: updateError } = await supabase
      .from("members")
      .update({ membership_end_at: newEnd })
      .eq("id", memberId)
      .select("*")
      .single();

    if (updateError) throw updateError;

    const now = nowJkt();
    const active = isMembershipActive(updatedMember.membership_end_at, now);

    res.json({
      id: updatedMember.id,
      membershipEndAt: formatDate(updatedMember.membership_end_at),
      isActive: active,
    });
  } catch (err: any) {
    console.error(err);

    if (
      err?.message &&
      err.message.includes("Tidak ada pembayaran membership untuk dibatalkan")
    ) {
      return res.status(400).json({
        message: "Tidak ada pembayaran membership untuk dibatalkan.",
      });
    }

    res.status(500).json({
      message: "Gagal membatalkan pembayaran membership terakhir.",
    });
  }
});

export default router;

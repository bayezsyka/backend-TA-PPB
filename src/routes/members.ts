// src/routes/members.ts
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../supabaseClient";
import { nowJkt, isMembershipActive } from "../utils/date";
import { getUsableCashbackBalance } from "../services/cashbackService";

const router = Router();

type MemberRow = {
  id: string;
  name: string;
  whatsapp: string;
  membership_end_at: string | null;
  is_archived?: boolean | null;
};

// --- Normalisasi nomor WhatsApp ---
function normalizeWhatsapp(raw: string): string {
  const digits = (raw || "").replace(/[^0-9]/g, "");
  if (!digits) return raw;

  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.startsWith("62")) return digits;
  return digits;
}

// --- Helper: cek bisa undo last payment ---
async function checkCanUndoLastMembershipPayment(
  memberId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("membership_payments")
    .select("id")
    .eq("member_id", memberId)
    .order("paid_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Error checking canUndoLastPayment:", error);
    return false;
  }
  return (data || []).length > 0;
}

// --- Helper: cashback pending (bulan depan) ---
async function getPendingCashbackBalance(
  memberId: string,
  at: any
): Promise<number> {
  const today = at.toISODate();

  const { data, error } = await supabase
    .from("cashback_ledger")
    .select("amount, entry_type, usable_from")
    .eq("member_id", memberId)
    .eq("entry_type", "earn")
    .gt("usable_from", today);

  if (error) {
    console.error("Error fetching pending cashback:", error);
    return 0;
  }

  return (data || []).reduce(
    (sum: number, row: any) => sum + (row.amount || 0),
    0
  );
}

// ----------------------
//  GET /members
//  -> list sederhana utk semua tab
// ----------------------
router.get("/", async (_req, res) => {
  try {
    // query sesederhana mungkin: select semua kolom, tanpa order rumit
    const { data, error } = await supabase
      .from("members")
      .select("id, name, whatsapp, membership_end_at");

    if (error) {
      console.error("Supabase error GET /members:", error);
      return res
        .status(500)
        .json({ message: "Gagal mengambil daftar member." });
    }

    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    const result = (data || []).map((row: any) => {
      const end: string | null = row.membership_end_at;
      const isActive = !!(end && end >= today);

      return {
        id: row.id,
        name: row.name,
        whatsapp: row.whatsapp,
        membershipEndAt: end,
        isActive,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Unhandled error GET /members:", err);
    res.status(500).json({ message: "Gagal mengambil daftar member." });
  }
});

// ----------------------
//  GET /members/:id/detail
// ----------------------
router.get("/:id/detail", async (req, res) => {
  const memberId = req.params.id;

  try {
    const now = nowJkt();

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("id, name, whatsapp, membership_end_at")
      .eq("id", memberId)
      .single();

    if (memberError || !member) {
      console.error("Supabase error GET /members/:id/detail:", memberError);
      return res.status(404).json({ message: "Member tidak ditemukan." });
    }

    const membershipEndAt = member.membership_end_at as string | null;
    const isActive = isMembershipActive(membershipEndAt, now);

    const usableCashback = await getUsableCashbackBalance(memberId, now);
    const pendingCashback = await getPendingCashbackBalance(memberId, now);
    const canUndoLastPayment = await checkCanUndoLastMembershipPayment(
      memberId
    );

    res.json({
      id: member.id,
      name: member.name,
      whatsapp: member.whatsapp,
      membershipEndAt,
      isActive,
      usableCashback,
      pendingCashback,
      canUndoLastPayment,
    });
  } catch (err) {
    console.error("Unhandled error GET /members/:id/detail:", err);
    res.status(500).json({ message: "Gagal memuat detail member." });
  }
});

// ----------------------
//  POST /members  (create)
// ----------------------
const CreateMemberSchema = z.object({
  name: z.string().min(1, "Nama wajib diisi"),
  whatsapp: z.string().min(5, "Nomor WhatsApp terlalu pendek"),
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateMemberSchema.parse(req.body);

    const name = parsed.name.trim();
    const whatsapp = normalizeWhatsapp(parsed.whatsapp);

    const { data, error } = await supabase
      .from("members")
      .insert({
        name,
        whatsapp,
        membership_end_at: null,
        // kalau punya kolom is_archived dan default false:
        // is_archived: false,
      } as any)
      .select("id, name, whatsapp, membership_end_at")
      .single();

    if (error) {
      console.error("Supabase error POST /members:", error);
      return res
        .status(500)
        .json({ message: "Error creating member", detail: error.message });
    }

    const row = data as MemberRow;
    const today = new Date().toISOString().slice(0, 10);
    const end: string | null = row.membership_end_at;
    const isActive = !!(end && end >= today);

    res.status(201).json({
      id: row.id,
      name: row.name,
      whatsapp: row.whatsapp,
      membershipEndAt: end,
      isActive,
    });
  } catch (err: any) {
    console.error("Unhandled error POST /members:", err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res.status(500).json({ message: "Error creating member" });
  }
});

// ----------------------
//  PUT /members/:id  (update nama & WA)
// ----------------------
const UpdateMemberSchema = z.object({
  name: z.string().min(1).optional(),
  whatsapp: z.string().min(5).optional(),
});

router.put("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const parsed = UpdateMemberSchema.parse(req.body);

    if (!parsed.name && !parsed.whatsapp) {
      return res.status(400).json({ message: "Tidak ada data yang diubah." });
    }

    const payload: any = {};
    if (parsed.name) payload.name = parsed.name.trim();
    if (parsed.whatsapp) payload.whatsapp = normalizeWhatsapp(parsed.whatsapp);

    const { data, error } = await supabase
      .from("members")
      .update(payload)
      .eq("id", memberId)
      .select("id, name, whatsapp, membership_end_at")
      .single();

    if (error) {
      console.error("Supabase error PUT /members/:id:", error);
      return res
        .status(500)
        .json({ message: "Gagal menyimpan perubahan member." });
    }

    const row = data as MemberRow;
    const today = new Date().toISOString().slice(0, 10);
    const end: string | null = row.membership_end_at;
    const isActive = !!(end && end >= today);

    res.json({
      id: row.id,
      name: row.name,
      whatsapp: row.whatsapp,
      membershipEndAt: end,
      isActive,
    });
  } catch (err: any) {
    console.error("Unhandled error PUT /members/:id:", err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res.status(500).json({ message: "Gagal menyimpan perubahan member." });
  }
});

// ----------------------
//  DELETE /members/:id  (soft-delete kalau bisa, fallback hard delete)
// ----------------------
router.delete("/:id", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { error: updateError } = await supabase
      .from("members")
      .update({ is_archived: true } as any)
      .eq("id", memberId);

    if (updateError) {
      console.warn(
        "Soft delete gagal, coba hard delete:",
        memberId,
        updateError
      );

      const { error: deleteError } = await supabase
        .from("members")
        .delete()
        .eq("id", memberId);

      if (deleteError) {
        console.error("Hard delete error /members/:id:", deleteError);
        return res.status(500).json({ message: "Gagal menghapus member." });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Unhandled error DELETE /members/:id:", err);
    res.status(500).json({ message: "Gagal menghapus member." });
  }
});

// ----------------------
//  POST /members/:id/membership/pay
// ----------------------
const PayMembershipSchema = z.object({
  amount: z.number().int().positive(),
});

router.post("/:id/membership/pay", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { amount } = PayMembershipSchema.parse(req.body);

    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("id, membership_end_at")
      .eq("id", memberId)
      .single();

    if (memberError || !member) {
      console.error("Supabase error membership/pay get member:", memberError);
      return res.status(404).json({ message: "Member tidak ditemukan." });
    }

    const now = nowJkt();
    const currentEndStr = member.membership_end_at as string | null;

    let baseDate = now;
    if (currentEndStr && isMembershipActive(currentEndStr, now)) {
      baseDate = nowJkt(currentEndStr);
    }

    const newEnd = baseDate.plus({ days: 30 });
    const newEndStr = newEnd.toISODate();

    const { error: payError } = await supabase
      .from("membership_payments")
      .insert({
        member_id: memberId,
        amount,
        paid_at: now.toISO(),
        previous_end_at: currentEndStr,
        new_end_at: newEndStr,
      } as any);

    if (payError) {
      console.error("Supabase error insert membership_payments:", payError);
      return res
        .status(500)
        .json({ message: "Gagal mencatat pembayaran membership." });
    }

    const { error: updateError } = await supabase
      .from("members")
      .update({ membership_end_at: newEndStr } as any)
      .eq("id", memberId);

    if (updateError) {
      console.error(
        "Supabase error update members membership_end_at:",
        updateError
      );
      return res
        .status(500)
        .json({ message: "Gagal mengupdate masa aktif membership." });
    }

    res.json({
      memberId,
      membershipEndAt: newEndStr,
    });
  } catch (err: any) {
    console.error("Unhandled error POST /members/:id/membership/pay:", err);
    if (err?.issues) {
      return res
        .status(400)
        .json({ message: "Invalid body", details: err.issues });
    }
    res
      .status(500)
      .json({ message: "Gagal mengkonfirmasi pembayaran membership." });
  }
});

// ----------------------
//  POST /members/:id/membership/undo-last-payment
// ----------------------
router.post("/:id/membership/undo-last-payment", async (req, res) => {
  const memberId = req.params.id;

  try {
    const { data, error } = await supabase
      .from("membership_payments")
      .select("id, previous_end_at")
      .eq("member_id", memberId)
      .order("paid_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error(
        "Supabase error select membership_payments undo-last-payment:",
        error
      );
      return res
        .status(500)
        .json({ message: "Gagal mengecek pembayaran membership." });
    }

    const last = (data || [])[0];
    if (!last) {
      return res.status(400).json({
        message: "Tidak ada pembayaran membership untuk dibatalkan.",
      });
    }

    const previousEnd = last.previous_end_at as string | null;

    const { error: updateError } = await supabase
      .from("members")
      .update({ membership_end_at: previousEnd } as any)
      .eq("id", memberId);

    if (updateError) {
      console.error(
        "Supabase error update members di undo-last-payment:",
        updateError
      );
      return res
        .status(500)
        .json({ message: "Gagal mengembalikan masa aktif membership." });
    }

    const { error: deleteError } = await supabase
      .from("membership_payments")
      .delete()
      .eq("id", last.id);

    if (deleteError) {
      console.error(
        "Supabase error delete membership_payments di undo-last-payment:",
        deleteError
      );
      // membership_end_at sudah di-rollback, jadi di sini kita anggap OK
    }

    res.json({
      memberId,
      membershipEndAt: previousEnd,
    });
  } catch (err) {
    console.error(
      "Unhandled error POST /members/:id/membership/undo-last-payment:",
      err
    );
    res.status(500).json({
      message: "Gagal membatalkan pembayaran membership terakhir.",
    });
  }
});

export default router;

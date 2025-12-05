// src/routes/members.ts
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../supabaseClient";
import { JAKARTA_TZ, nowJkt, isMembershipActive } from "../utils/date";
import { getUsableCashbackBalance } from "../services/cashbackService";
import PDFDocument from "pdfkit";
import { DateTime } from "luxon";

const router = Router();

type MemberRow = {
  id: string;
  name: string;
  whatsapp: string;
  membership_end_at: string | null;
  is_archived?: boolean | null;
};

// === ENDPOINT BARU ===
// GET /members/:id/transactions/last-30-days/pdf
// Generate PDF riwayat transaksi member (30 hari terakhir)
router.get(
  "/:id/transactions/last-30-days/pdf",
  async (req, res): Promise<void> => {
    // validasi param id
    const ParamsSchema = z.object({
      id: z.string().uuid(),
    });

    const parsed = ParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ message: "Member ID tidak valid." });
      return;
    }

    const memberId = parsed.data.id;

    try {
      // --- ambil data member ---
      const { data: memberRow, error: memberError } = await supabase
        .from("members")
        .select("id, name, whatsapp")
        .eq("id", memberId)
        .maybeSingle();

      if (memberError) throw memberError;

      if (!memberRow) {
        res.status(404).json({ message: "Member tidak ditemukan." });
        return;
      }

      // --- tentukan range 30 hari terakhir (pakai zona Jakarta) ---
      const now = nowJkt(); // DateTime luxon
      const start = now.minus({ days: 30 }).startOf("day");
      const startDayKey = start.toISODate(); // YYYY-MM-DD, cocok ke kolom day_key

      // --- ambil transaksi member ini 30 hari terakhir ---
      const { data: txRows, error: txError } = await supabase
        .from("transactions")
        .select(
          "id, transacted_at, total_amount, cashback_earned, cashback_spent"
        )
        .eq("member_id", memberId)
        .gte("day_key", startDayKey)
        .order("transacted_at", { ascending: true });

      if (txError) throw txError;

      const rows =
        (txRows as
          | {
              id: string;
              transacted_at: string;
              total_amount: number;
              cashback_earned: number;
              cashback_spent: number;
            }[]
          | null) ?? [];

      // --- fungsi bantu format rupiah ---
      const formatCurrency = (amount: number | null | undefined) =>
        "Rp " + (amount ?? 0).toLocaleString("id-ID");

      // hitung ringkasan
      const totalAmount = rows.reduce(
        (sum, r) => sum + (r.total_amount ?? 0),
        0
      );
      const totalEarned = rows.reduce(
        (sum, r) => sum + (r.cashback_earned ?? 0),
        0
      );
      const totalSpent = rows.reduce(
        (sum, r) => sum + (r.cashback_spent ?? 0),
        0
      );

      // --- siapkan response PDF ---
      const safeName = (memberRow.name || "member")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeName}-transactions-last-30-days.pdf"`
      );

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      doc.pipe(res);

      // --- header dokumen ---
      doc.info.Title = `Riwayat Transaksi 30 Hari Terakhir - ${memberRow.name}`;
      doc.info.Author = "Burjo Lestari Member App";

      doc.fontSize(16).text("Riwayat Transaksi Member", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Nama  : ${memberRow.name}`);
      doc.text(`WhatsApp : ${memberRow.whatsapp || "-"}`);
      doc.text(
        `Periode : ${start.toFormat("dd MMM yyyy")} - ${now.toFormat(
          "dd MMM yyyy"
        )}`
      );
      doc.text(`Dibuat  : ${now.toFormat("dd MMM yyyy HH:mm")} WIB`);

      doc.moveDown();

      // --- ringkasan ---
      doc.fontSize(12).text("Ringkasan 30 hari terakhir", {
        underline: true,
      });
      doc.moveDown(0.3);
      doc.fontSize(11);
      doc.text(`Total transaksi       : ${rows.length}`);
      doc.text(`Total nominal         : ${formatCurrency(totalAmount)}`);
      doc.text(`Total cashback dapat  : ${formatCurrency(totalEarned)}`);
      doc.text(`Total cashback dipakai: ${formatCurrency(totalSpent)}`);

      doc.moveDown();

      if (rows.length === 0) {
        doc
          .fontSize(11)
          .text("Belum ada transaksi pada periode 30 hari terakhir.", {
            align: "left",
          });
        doc.end();
        return;
      }

      // --- tabel detail transaksi ---
      const tableTop = doc.y + 4;
      const colDate = 40;
      const colTime = 130;
      const colTotal = 210;
      const colEarned = 320;
      const colSpent = 430;

      doc.fontSize(11);
      doc.text("Tanggal", colDate, tableTop);
      doc.text("Jam", colTime, tableTop);
      doc.text("Total", colTotal, tableTop, { width: 90, align: "right" });
      doc.text("CB Dapat", colEarned, tableTop, {
        width: 90,
        align: "right",
      });
      doc.text("CB Pakai", colSpent, tableTop, {
        width: 90,
        align: "right",
      });

      doc
        .moveTo(colDate, tableTop + 14)
        .lineTo(550, tableTop + 14)
        .stroke();

      let y = tableTop + 20;

      rows.forEach((row) => {
        const dt = DateTime.fromISO(row.transacted_at, {
          zone: JAKARTA_TZ,
        });
        const dateStr = dt.toFormat("dd MMM yyyy");
        const timeStr = dt.toFormat("HH:mm");

        // pagination sederhana
        if (y > 760) {
          doc.addPage();
          y = 40;

          doc.fontSize(11);
          doc.text("Tanggal", colDate, y);
          doc.text("Jam", colTime, y);
          doc.text("Total", colTotal, y, {
            width: 90,
            align: "right",
          });
          doc.text("CB Dapat", colEarned, y, {
            width: 90,
            align: "right",
          });
          doc.text("CB Pakai", colSpent, y, {
            width: 90,
            align: "right",
          });

          doc
            .moveTo(colDate, y + 14)
            .lineTo(550, y + 14)
            .stroke();

          y += 20;
        }

        doc.fontSize(10);
        doc.text(dateStr, colDate, y);
        doc.text(timeStr, colTime, y);
        doc.text(formatCurrency(row.total_amount), colTotal, y, {
          width: 90,
          align: "right",
        });
        doc.text(formatCurrency(row.cashback_earned), colEarned, y, {
          width: 90,
          align: "right",
        });
        doc.text(formatCurrency(row.cashback_spent), colSpent, y, {
          width: 90,
          align: "right",
        });

        y += 16;
      });

      doc.end();
    } catch (err: any) {
      console.error(
        "Error generating PDF for member transactions last 30 days:",
        err
      );
      res.status(500).json({
        message: "Gagal membuat PDF riwayat transaksi member.",
      });
    }
  }
);

export default router;

// src/index.ts
import express from "express";
import cors from "cors";
import morgan from "morgan";

import membersRouter from "./routes/members";
import transactionsRouter from "./routes/transactions";

const app = express();
const PORT = process.env.PORT || 4000;

// --- Middleware dasar ---
app.use(
  cors({
    origin: "*", // bebas diakses: expo, web, postman, dll
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "dev"));

// --- Health check ---
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Member Lestari API" });
});

// --- Routes utama ---
app.use("/members", membersRouter);
app.use("/transactions", transactionsRouter);

// --- Fallback 404 (optional tapi rapi) ---
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ message: "Endpoint tidak ditemukan." });
});

// --- Global error handler ---
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return;

    res
      .status(err?.statusCode || 500)
      .json({ message: err?.message || "Terjadi kesalahan server." });
  }
);

// --- Local dev server ---
// Di Vercel, yang dipakai cuma `export default app` (tanpa listen)
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
  });
}

export default app;

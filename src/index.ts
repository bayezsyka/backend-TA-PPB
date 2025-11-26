import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import membersRouter from "./routes/members";
import transactionsRouter from "./routes/transactions";
import { apiKeyAuth } from "./middleware/apiKeyAuth";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Endpoint cek server
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Semua endpoint utama pakai API key
app.use(apiKeyAuth);

app.use("/members", membersRouter);
app.use("/transactions", transactionsRouter);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});

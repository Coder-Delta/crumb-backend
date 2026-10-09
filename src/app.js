import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import apiRouter from "./routes/api.routes.js";
import { errorHandler } from "./middleware.js";

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY)
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
const directives = helmet.contentSecurityPolicy.getDefaultDirectives();
directives["script-src"] = [
  "'self'",
  "https://checkout.razorpay.com",
  "https://accounts.google.com",
];
directives["frame-src"] = [
  "'self'",
  "https://api.razorpay.com",
  "https://checkout.razorpay.com",
  "https://*.razorpay.com",
  "https://accounts.google.com",
];
directives["connect-src"] = [
  "'self'",
  "https://api.razorpay.com",
  "https://*.razorpay.com",
];
app.use(
  helmet({
    contentSecurityPolicy: { directives },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }),
);
app.use(compression());
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      callback(
        Object.assign(new Error("Origin is not allowed by CORS."), {
          status: 403,
        }),
      );
    },
    credentials: true,
  }),
);
// Webhooks require the exact raw payload bytes for HMAC verification.
app.use(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
);
app.use(express.json({ limit: "1mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
app.use("/api", apiRouter);
app.use((req, res) =>
  res.status(404).json({ message: "That endpoint does not exist." }),
);
app.use(errorHandler);
export default app;

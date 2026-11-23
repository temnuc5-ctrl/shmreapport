import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import { handleGenerateSession } from "./routes/generate-session";
import { handleSaveReport } from "./routes/save-report";
import { handleListReportCatalog, handleListReports } from "./routes/list-reports";
import { handleGenerateRapport, handleGetRapport } from "./routes/generate-rapport";
import authRoutes from "./routes/auth";
import { consume, getClientIp } from "./lib/rateLimit";
import { requireRapportAuth } from "./lib/auth";

const APP_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"];

function buildCorsOrigins(): string[] {
  return [
    ...APP_ORIGINS,
    ...(process.env.CORS_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ];
}

/** En-têtes de sécurité appliqués à toutes les réponses. */
function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
}

/** Plafond général par IP sur l'API. */
function apiLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = getClientIp(req as unknown as { headers: Record<string, unknown>; ip?: string });
  const result = consume(`api:${ip}`, 60_000, 300);
  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    return res.status(429).json({ error: "طلبات كثيرة جدًا. أعد المحاولة بعد قليل." });
  }
  return next();
}

export function createServer() {
  const app = express();

  // Middleware
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true); // même origine / requête serveur
        return callback(null, buildCorsOrigins().includes(origin));
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Api-Key"],
      maxAge: 600,
    }),
  );
  app.use(securityHeaders);
  app.use("/api", apiLimiter);
  app.use(express.json({ limit: "10mb", type: "*/*" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));
  app.use((req, _res, next) => {
    if (typeof req.body === "string") {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        // Corps malformé : la validation de route le rejettera.
      }
    }
    next();
  });

  // Authentification par variables d’environnement.
  app.use("/api/auth", authRoutes);

  // Example API routes
  app.get("/api/ping", (_req, res) => {
    const ping = process.env.PING_MESSAGE ?? "ping";
    res.json({ message: ping });
  });

  const requireApiKey = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = process.env.REPORTS_API_KEY;
    if (!key) return res.status(503).json({ error: "Serveur non configuré" });
    const provided = req.headers["x-api-key"];
    if (typeof provided !== "string" || provided.length !== key.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(key))) {
      return res.status(401).json({ error: "Non autorise" });
    }
    return next();
  };

  app.post("/api/generate-session", requireApiKey, handleGenerateSession);
  app.post("/api/save-report", requireApiKey, handleSaveReport);
  app.get("/api/reports", requireApiKey, handleListReports);
  app.get("/api/report-catalog", requireRapportAuth, handleListReportCatalog);
  app.post("/api/rapport", requireRapportAuth, handleGenerateRapport);
  app.get("/api/rapport/:jobId", requireRapportAuth, handleGetRapport);

  return app;
}

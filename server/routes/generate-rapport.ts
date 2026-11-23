import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import { consume, getClientIp } from "../lib/rateLimit";

const CREAO_API_BASE = "https://developer.creao.ai/v2";
const DEFAULT_AGENT_ID = "db2ebc26-4444-4662-9ea9-ca6024ff52dc";
const JOB_AUDIENCE = "shm-rapport-creao-run";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_TABLES = new Set(["reports", "sessions"]);

type ReportMode = "sequence" | "rapide";

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function safePdfUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.toLowerCase().endsWith(".pdf") && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function getPdfArtifactUrl(result: Record<string, any>): string | null {
  if (typeof result.pdf_url === "string") return safePdfUrl(result.pdf_url);
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const pdf = artifacts.find((artifact: any) =>
    typeof artifact?.name === "string" && /\.pdf$/i.test(artifact.name),
  );
  return safePdfUrl(pdf?.url);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value.slice(0, 20).map((item) => item.slice(0, 240));
}

function getCreaoKey(): string | null {
  return process.env.CREAO_API_KEY || null;
}

function getRunSummary(result: Record<string, any>) {
  return {
    ...result,
    ...(result.meta && typeof result.meta === "object" ? result.meta : {}),
    ...(result.summary && typeof result.summary === "object" ? result.summary : {}),
  };
}

export const handleGenerateRapport: RequestHandler = async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const mode = payload.mode ?? "sequence";
  const language = payload.language ?? "ar";
  const question = typeof payload.question === "string" ? payload.question.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "تقرير عام للفترة";

  if (mode !== "sequence" && mode !== "rapide") {
    res.status(400).json({ error: "Mode de rapport invalide." });
    return;
  }
  if (!question || question.length > 2000) {
    res.status(400).json({ error: "La question est obligatoire (2000 caractères maximum)." });
    return;
  }
  if (language !== "ar" && language !== "fr") {
    res.status(400).json({ error: "La langue doit être ar ou fr." });
    return;
  }
  if (title.length > 160) {
    res.status(400).json({ error: "Le titre ne peut pas dépasser 160 caractères." });
    return;
  }

  const inputs: Record<string, unknown> = { mode, question, title: title || "تقرير عام للفترة", language };

  if (mode === "sequence") {
    if (!isIsoDate(payload.date_from) || !isIsoDate(payload.date_to)) {
      res.status(400).json({ error: "date_from et date_to doivent être au format YYYY-MM-DD." });
      return;
    }
    if (payload.date_from > payload.date_to) {
      res.status(400).json({ error: "date_from doit précéder ou égaler date_to." });
      return;
    }
    inputs.date_from = payload.date_from;
    inputs.date_to = payload.date_to;
  } else {
    if (payload.date_from !== undefined || payload.date_to !== undefined) {
      if (!isIsoDate(payload.date_from) || !isIsoDate(payload.date_to)) {
        res.status(400).json({ error: "date_from et date_to doivent être renseignées ensemble au format YYYY-MM-DD." });
        return;
      }
      if (payload.date_from > payload.date_to) {
        res.status(400).json({ error: "date_from doit précéder ou égaler date_to." });
        return;
      }
      inputs.date_from = payload.date_from;
      inputs.date_to = payload.date_to;
    }

    if (typeof payload.category === "string" && payload.category.trim()) {
      if (payload.category.length > 120) {
        res.status(400).json({ error: "Le filtre de catégorie ne peut pas dépasser 120 caractères." });
        return;
      }
      inputs.category = payload.category.trim();
    }

    if (payload.tables !== undefined && typeof payload.tables !== "string") {
      res.status(400).json({ error: "tables doit être une liste CSV." });
      return;
    }
    const tables = typeof payload.tables === "string" && payload.tables.trim()
      ? [...new Set(payload.tables.split(",").map((table: string) => table.trim()).filter(Boolean))]
      : ["reports", "sessions"];
    if (!tables.length || tables.some((table: string) => !ALLOWED_TABLES.has(table))) {
      res.status(400).json({ error: "Seules les tables reports et sessions sont autorisées." });
      return;
    }
    inputs.tables = tables.join(",");
  }

  const apiKey = getCreaoKey();
  const jwtSecret = process.env.JWT_SECRET;
  const userId = req.rapport_user?.sub;
  if (!apiKey || !jwtSecret || !userId) {
    res.status(503).json({ error: "La connexion à CREAO n’est pas configurée sur le serveur." });
    return;
  }

  const ip = getClientIp(req as unknown as { headers: Record<string, unknown>; ip?: string });
  const rateLimit = consume(`rapport:${ip}`, 60_000, 1);
  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: "Un rapport vient déjà d’être demandé. Réessayez dans une minute." });
    return;
  }

  try {
    const upstream = await fetch(`${CREAO_API_BASE}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        agent_id: process.env.CREAO_AGENT_ID || DEFAULT_AGENT_ID,
        input: inputs,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await upstream.json().catch(() => null) as Record<string, any> | null;
    if (!upstream.ok || typeof data?.run_id !== "string") {
      if (upstream.status === 429) {
        res.status(429).json({ error: "Le service CREAO limite actuellement les demandes. Réessayez plus tard." });
        return;
      }
      if (upstream.status === 404) {
        res.status(502).json({ error: "L’agent CREAO est introuvable dans le projet associé à cette clé. Vérifiez que l’agent et la clé Project appartiennent au même projet." });
        return;
      }
      if (upstream.status === 401) {
        res.status(502).json({ error: "La clé Project CREAO n’est pas autorisée pour cette API." });
        return;
      }
      console.error("CREAO run creation failed:", upstream.status, data?.error);
      res.status(502).json({ error: "Le service CREAO n’a pas pu démarrer la génération." });
      return;
    }

    const jobId = jwt.sign({ sub: userId, run_id: data.run_id }, jwtSecret, {
      algorithm: "HS256",
      audience: JOB_AUDIENCE,
      issuer: "shm-rapports",
      expiresIn: "10m",
    });
    res.status(202).json({ job_id: jobId, status: data.status === "running" ? "running" : "pending" });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      res.status(504).json({ error: "Impossible de joindre CREAO pour démarrer le rapport." });
      return;
    }
    console.error("CREAO run creation failed:", error);
    res.status(502).json({ error: "Impossible de joindre le service CREAO." });
  }
};

export const handleGetRapport: RequestHandler = async (req, res) => {
  const apiKey = getCreaoKey();
  const jwtSecret = process.env.JWT_SECRET;
  const userId = req.rapport_user?.sub;
  if (!apiKey || !jwtSecret || !userId) {
    res.status(503).json({ error: "La connexion à CREAO n’est pas configurée sur le serveur." });
    return;
  }

  const jobId = req.params.jobId;
  if (typeof jobId !== "string") {
    res.status(400).json({ error: "L’identifiant de suivi est invalide." });
    return;
  }

  let runId: string;
  try {
    const ticket = jwt.verify(jobId, jwtSecret, {
      algorithms: ["HS256"],
      audience: JOB_AUDIENCE,
      issuer: "shm-rapports",
    }) as jwt.JwtPayload;
    if (ticket.sub !== userId || typeof ticket.run_id !== "string") {
      res.status(403).json({ error: "Ce rapport ne vous appartient pas." });
      return;
    }
    runId = ticket.run_id;
  } catch {
    res.status(400).json({ error: "Le suivi de ce rapport a expiré. Relancez la génération." });
    return;
  }

  try {
    const upstream = await fetch(`${CREAO_API_BASE}/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const run = await upstream.json().catch(() => null) as Record<string, any> | null;
    if (!upstream.ok || !run) {
      console.error("CREAO run lookup failed:", upstream.status, run?.error);
      res.status(502).json({ error: "Impossible de récupérer l’état du rapport." });
      return;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      res.status(502).json({ error: "CREAO n’a pas pu terminer la génération du rapport." });
      return;
    }
    if (run.status !== "completed") {
      res.json({ status: run.status === "running" ? "running" : "pending" });
      return;
    }

    const result = run.result && typeof run.result === "object" ? run.result : {};
    const summary = getRunSummary(result);
    const pdfUrl = getPdfArtifactUrl(result);
    if (!pdfUrl) {
      res.status(502).json({ error: "CREAO a terminé le rapport sans fournir de lien PDF public valide." });
      return;
    }

    const period = summary.period && typeof summary.period === "object" ? summary.period : undefined;
    res.json({
      status: "completed",
      pdf_url: pdfUrl,
      ...(period ? { period } : {}),
      ...(typeof summary.reports === "number" ? { reports: summary.reports } : {}),
      ...(typeof summary.sessions === "number" ? { sessions: summary.sessions } : {}),
      ...(typeof summary.participants_total === "number" ? { participants_total: summary.participants_total } : {}),
      ...(typeof summary.girls_ratio_pct === "number" ? { girls_ratio_pct: summary.girls_ratio_pct } : {}),
      ...(typeof summary.sessions_without_report === "number" ? { sessions_without_report: summary.sessions_without_report } : {}),
      ...(stringList(summary.recurring_negative) ? { recurring_negative: stringList(summary.recurring_negative) } : {}),
      ...(typeof summary.synthesis_used === "boolean" ? { synthesis_used: summary.synthesis_used } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      res.status(504).json({ error: "Le service CREAO met trop de temps à répondre." });
      return;
    }
    console.error("CREAO run lookup failed:", error);
    res.status(502).json({ error: "Impossible de joindre le service CREAO." });
  }
};

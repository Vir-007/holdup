import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader so the app runs with zero setup beyond `npm install`.
function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

loadDotEnv();

const env = (k: string, d = "") => process.env[k] ?? d;

export const config = {
  paypal: {
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
    api: env("PAYPAL_API", "https://api-m.sandbox.paypal.com"),
    webhookId: env("PAYPAL_WEBHOOK_ID"),
  },
  ai: {
    baseUrl: env("AI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/"),
    apiKey: env("AI_API_KEY"),
    model: env("AI_MODEL", "gemini-3.1-flash-lite"),
  },
  largePaymentCents: Math.round(Number(env("LARGE_PAYMENT", "200")) * 100),
  port: Number(env("PORT", "8787")),
  host: env("HOST", "127.0.0.1"),
  dbPath: env("DB_PATH", "holdup.db"),
  demo: env("DEMO") === "1",
};

export const paypalConfigured = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);

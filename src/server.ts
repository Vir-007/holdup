import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { categoryLabel } from "./ai.ts";
import { config, paypalConfigured } from "./config.ts";
import { Store } from "./db.ts";
import { loadDemo } from "./demo.ts";
import { PayPal, PayPalError, toCents, type Capture } from "./paypal.ts";
import { ActionError, Service } from "./service.ts";

export function createApp(service: Service) {
  const app = new Hono();
  const { store } = service;

  app.onError((err, c) => {
    const status = (err instanceof ActionError ? err.status : err instanceof PayPalError ? 502 : 500) as ContentfulStatusCode;
    if (status === 500) console.error(err);
    return c.json({ error: err.message }, status);
  });

  const view = (id: string) => {
    const payment = service.getPayment(id);
    const saved = store.getAssessment(id);
    const assessment = saved?.assessment ?? service.rulesFor(payment);
    return {
      payment,
      assessment: { ...assessment, label: categoryLabel(assessment.category) },
      explanation: saved?.explanation ?? null,
      order: assessment.matchedOrderId ? store.listOrders().find((o) => o.id === assessment.matchedOrderId) ?? null : null,
      audit: store.listAudit(id),
    };
  };

  app.get("/api/status", (c) =>
    c.json({
      demo: config.demo,
      paypal: paypalConfigured(),
      sandbox: config.paypal.api.includes("sandbox"),
      ai: config.ai.apiKey ? config.ai.model : null,
    }),
  );

  app.get("/api/payments", (c) =>
    c.json(
      store.listPayments().map((p) => {
        const a = store.getAssessment(p.id)?.assessment ?? service.rulesFor(p);
        return { ...p, risk: a.risk, category: a.category, label: categoryLabel(a.category) };
      }),
    ),
  );

  app.get("/api/payments/:id", (c) => c.json(view(c.req.param("id"))));

  app.post("/api/payments/:id/analyze", async (c) => {
    await service.analyze(c.req.param("id"));
    return c.json(view(c.req.param("id")));
  });

  app.post("/api/payments/:id/message", async (c) => {
    const { message } = await c.req.json<{ message: string }>();
    await service.setMessage(c.req.param("id"), String(message ?? ""));
    return c.json(view(c.req.param("id")));
  });

  app.post("/api/payments/:id/refund", async (c) => {
    const b = await c.req.json<{ amount: string; confirm: string; requestKey: string }>();
    const result = await service.refund(c.req.param("id"), {
      amountCents: toCents(String(b.amount ?? "")),
      confirm: String(b.confirm ?? ""),
      requestKey: String(b.requestKey ?? ""),
    });
    return c.json({ ...view(c.req.param("id")), result });
  });

  app.post("/api/payments/:id/hold", (c) => {
    service.hold(c.req.param("id"));
    return c.json(view(c.req.param("id")));
  });

  app.post("/api/payments/:id/keep", async (c) => {
    const b = await c.req.json<{ remember?: "customer" | "payout" }>().catch(() => ({}) as { remember?: undefined });
    service.keep(c.req.param("id"), b.remember === "customer" || b.remember === "payout" ? b.remember : undefined);
    return c.json(view(c.req.param("id")));
  });

  app.post("/api/payments/:id/report", (c) => {
    const r = service.report(c.req.param("id"));
    return c.json({ ...view(c.req.param("id")), ...r });
  });

  app.get("/api/request-key", (c) => c.json({ key: service.newRequestKey() }));

  app.post("/api/sync", async (c) => c.json(await service.sync()));

  app.post("/api/lookup", async (c) => {
    const b = await c.req.json<{ id: string; payerEmail?: string; payerName?: string; note?: string }>();
    if (!b.id?.trim()) throw new ActionError(400, "Enter a transaction ID.");
    await service.lookup(b.id, b);
    return c.json(view(b.id.trim()));
  });

  app.get("/api/orders", (c) => c.json(store.listOrders()));
  app.post("/api/orders", async (c) => {
    const b = await c.req.json<{ id?: string; buyerEmail?: string; buyerName?: string; total: string; description: string }>();
    const totalCents = toCents(String(b.total));
    if (!(totalCents > 0) || !b.description?.trim()) throw new ActionError(400, "An order needs a description and a total.");
    store.upsertOrder({
      id: b.id?.trim() || `ORD-${Date.now().toString(36).toUpperCase()}`,
      buyerEmail: b.buyerEmail?.trim() || null, buyerName: b.buyerName?.trim() || null,
      totalCents, currency: "USD", description: b.description.trim(), status: "open", createdAt: new Date().toISOString(),
    });
    return c.json(store.listOrders());
  });

  app.get("/api/known-payers", (c) => c.json(store.listKnownPayers()));
  app.post("/api/known-payers", async (c) => {
    const b = await c.req.json<{ email: string; name: string; kind: "customer" | "payout"; note?: string }>();
    if (!b.email?.includes("@") || !["customer", "payout"].includes(b.kind)) throw new ActionError(400, "Enter an email and pick customer or payout.");
    store.upsertKnownPayer({ email: b.email.trim(), name: b.name?.trim() || b.email.trim(), kind: b.kind, note: b.note?.trim() ?? "" });
    return c.json(store.listKnownPayers());
  });

  app.get("/api/audit", (c) => c.json(store.listAudit()));

  app.post("/api/demo/reset", async (c) => {
    if (!config.demo) throw new ActionError(403, "Only available in demo mode.");
    loadDemo(store);
    await Promise.all(store.listPayments().map((p) => service.analyze(p.id)));
    return c.json({ ok: true });
  });

  // PayPal webhook: PAYMENT.CAPTURE.COMPLETED. Unsigned events are refused, so nobody else can feed in fake payments.
  app.post("/webhooks/paypal", async (c) => {
    const event = await c.req.json<{ event_type: string; resource: Capture }>();
    if (!service.paypal) return c.json({ ignored: "paypal not configured" });
    if (!config.paypal.webhookId) return c.json({ error: "set PAYPAL_WEBHOOK_ID to accept webhooks" }, 400);
    const ok = await service.paypal.verifyWebhook(c.req.header(), event, config.paypal.webhookId);
    if (!ok) return c.json({ error: "bad signature" }, 400);
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") await service.onCaptureCompleted(event.resource);
    return c.json({ ok: true });
  });

  app.use("/*", serveStatic({ root: "./public" }));
  return app;
}

if (import.meta.main) {
  // There is no login, and the refund button moves real money, so only demo mode may listen beyond this machine.
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  if (!local && !config.demo) {
    console.error(`Refusing to listen on ${config.host}: Hold Up has no login, so outside demo mode it only runs on localhost.`);
    process.exit(1);
  }
  const store = new Store(config.demo ? ":memory:" : config.dbPath);
  const service = new Service({ store, paypal: paypalConfigured() && !config.demo ? new PayPal() : null });
  if (config.demo) {
    loadDemo(store);
    for (const p of store.listPayments()) store.saveAssessment(p.id, service.rulesFor(p), null);
    Promise.all(store.listPayments().map((p) => service.analyze(p.id))).then(() => console.log("Demo payments analysed."));
  }
  serve({ fetch: createApp(service).fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`Hold Up running at http://${local ? "localhost" : config.host}:${info.port}${config.demo ? " (demo mode)" : ""}`);
  });
}

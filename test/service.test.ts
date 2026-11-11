import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleExplanation } from "../src/ai.ts";
import { Store } from "../src/db.ts";
import { PayPal, type Fetch } from "../src/paypal.ts";
import { ActionError, Service } from "../src/service.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakePayPal() {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? String(init.body) : null });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "T", expires_in: 3600 });
    if (url.includes("/refund")) return Response.json({ id: "R1", status: "COMPLETED" }, { status: 201 });
    return Response.json({ message: "unexpected" }, { status: 404 });
  };
  return { calls, paypal: new PayPal({ fetchImpl, api: "https://api.test", clientId: "id", clientSecret: "s" }) };
}

function setup() {
  const store = new Store(":memory:");
  const { calls, paypal } = fakePayPal();
  const service = new Service({ store, paypal, explainFn: async (p, a) => ruleExplanation(p, a) });
  store.upsertPayment({ id: "CAP1", payerEmail: "s@example.com", payerName: "S", amountCents: 72500, currency: "USD", feeCents: 2563, note: null, receivedAt: new Date().toISOString(), source: "lookup" });
  return { store, service, calls };
}

const key = "abcdef12-3456";

test("refund needs the typed amount to match", async () => {
  const { service, calls } = setup();
  await assert.rejects(service.refund("CAP1", { amountCents: 72500, confirm: "725", requestKey: key }), ActionError);
  assert.equal(calls.length, 0);
});

test("refund can't exceed what's left on the payment", async () => {
  const { service } = setup();
  await assert.rejects(service.refund("CAP1", { amountCents: 72501, confirm: "725.01", requestKey: key }), /at most \$725\.00/);
});

test("refund goes to the original capture with an idempotency key, and a repeat doesn't refund twice", async () => {
  const { service, store, calls } = setup();
  const first = await service.refund("CAP1", { amountCents: 72500, confirm: "$725.00", requestKey: key });
  assert.equal(first.already, false);
  const refundCalls = calls.filter((c) => c.url.includes("/refund"));
  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0].url, "https://api.test/v2/payments/captures/CAP1/refund");
  assert.equal(refundCalls[0].headers["PayPal-Request-Id"], `holdup-CAP1-${key}`);
  assert.deepEqual(JSON.parse(refundCalls[0].body as string).amount, { currency_code: "USD", value: "725.00" });

  const again = await service.refund("CAP1", { amountCents: 72500, confirm: "725.00", requestKey: key });
  assert.equal(again.already, true);
  // A fresh confirmation on a fully refunded payment is rejected before any PayPal call.
  const fresh = await service.refund("CAP1", { amountCents: 72500, confirm: "725.00", requestKey: "fresh-key-0001" }).catch((e) => e);
  assert.ok(fresh instanceof ActionError);
  assert.equal(calls.filter((c) => c.url.includes("/refund")).length, 1);
  assert.equal(store.getPayment("CAP1")?.status, "refunded");
  assert.equal(store.getPayment("CAP1")?.refundedCents, 72500);
});

test("the same confirmation replayed after a partial refund is recognised, not repeated", async () => {
  const { service, calls } = setup();
  await service.refund("CAP1", { amountCents: 50000, confirm: "500.00", requestKey: key });
  const replay = await service.refund("CAP1", { amountCents: 50000, confirm: "500.00", requestKey: key });
  assert.equal(replay.already, true);
  assert.equal(calls.filter((c) => c.url.includes("/refund")).length, 1);
});

test("two clicks racing each other refund once and count once", async () => {
  const { service, store, calls } = setup();
  const results = await Promise.allSettled([
    service.refund("CAP1", { amountCents: 72500, confirm: "725.00", requestKey: key }),
    service.refund("CAP1", { amountCents: 72500, confirm: "725.00", requestKey: key }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls.filter((c) => c.url.includes("/refund")).length, 1);
  assert.equal(store.getPayment("CAP1")?.refundedCents, 72500);
});

test("the only money-moving PayPal endpoint used is a capture refund", async () => {
  const { service, calls } = setup();
  await service.refund("CAP1", { amountCents: 1000, confirm: "10.00", requestKey: key });
  service.hold("CAP1");
  service.report("CAP1");
  service.keep("CAP1");
  const posts = calls.filter((c) => c.method === "POST" && !c.url.endsWith("/oauth2/token"));
  assert.ok(posts.every((c) => /\/v2\/payments\/captures\/[^/]+\/refund$/.test(c.url)));
});

test("every action lands in the audit log", async () => {
  const { service, store } = setup();
  service.hold("CAP1");
  await service.refund("CAP1", { amountCents: 1000, confirm: "10.00", requestKey: key });
  assert.deepEqual(store.listAudit("CAP1").map((e) => e.action), ["refund", "hold"]);
});

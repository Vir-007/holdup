// Creates real PayPal sandbox payments for the demo and feeds them to a running Hold Up.
//
//   npm start                     # in one terminal (not DEMO mode)
//   npm run seed -- overpayment   # an $800 card payment against a $300 order
//
// The "stranger sends money" case needs a sandbox personal account to press Send in
// PayPal's own UI; see scripts/README.md. Then add it with:
//   npm run seed -- add <transaction id> <sender email> "<sender name>" "<message they sent>"
import { randomUUID } from "node:crypto";
import { config } from "../src/config.ts";
import { PayPal } from "../src/paypal.ts";

const APP = process.env.HOLDUP_URL ?? `http://localhost:${config.port}`;

async function app(path: string, body?: unknown) {
  const res = await fetch(`${APP}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`);
  return json;
}

async function paypalToken() {
  const res = await fetch(`${config.paypal.api}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Pays the business with a sandbox test card, without a buyer login. Returns the capture. */
async function cardPayment(value: string, item: string) {
  const res = await fetch(`${config.paypal.api}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await paypalToken()}`, "Content-Type": "application/json", "PayPal-Request-Id": randomUUID() },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        description: item,
        amount: { currency_code: "USD", value, breakdown: { item_total: { currency_code: "USD", value } } },
        items: [{ name: item, quantity: "1", unit_amount: { currency_code: "USD", value } }],
      }],
      // PayPal's public sandbox test Visa; no real money.
      payment_source: { card: { number: "4032039317984658", expiry: "2030-12", name: "Dana Whitfield" } },
    }),
  });
  const order = (await res.json()) as { status: string; purchase_units?: { payments?: { captures?: { id: string }[] } }[] };
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || !capture) throw new Error(`Card payment failed: ${JSON.stringify(order).slice(0, 400)}`);
  return capture.id;
}

async function overpayment() {
  const buyer = { buyerEmail: "dana.whitfield@example.com", buyerName: "Dana Whitfield" };
  await app("/api/orders", { id: "ORD-2001", description: "1970s suede fringe jacket", total: "300.00", ...buyer });
  const captureId = await cardPayment("800.00", "1970s suede fringe jacket + shipping");
  console.log(`Sandbox capture ${captureId}: $800.00 against a $300.00 order`);
  await app("/api/lookup", { id: captureId, payerEmail: buyer.buyerEmail, payerName: buyer.buyerName, note: "for the jacket + shipping" });
  const view = await app(`/api/payments/${captureId}/message`, {
    message: "Paid $800. The extra $500 is for my shipper who will pick up the jacket, please send it to them by Cash App before they come tomorrow.",
  });
  console.log(`Hold Up: ${view.assessment.risk} risk, ${view.assessment.label}; suggests refunding $${(view.assessment.suggestedRefundCents / 100).toFixed(2)}`);
  console.log(`Open ${APP}/#${captureId}`);
}

async function add(id: string, email: string, name: string, message?: string) {
  const view = await app("/api/lookup", { id, payerEmail: email, payerName: name });
  if (message) await app(`/api/payments/${id}/message`, { message });
  console.log(`Hold Up: ${view.assessment.risk} risk, ${view.assessment.label}`);
  console.log(`Open ${APP}/#${id}`);
}

/** Show what PayPal itself says about a capture (to verify a refund landed). */
async function check(id: string) {
  const c = await new PayPal().getCapture(id);
  console.log(`${c.id}: ${c.status}, $${c.amount.value}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "overpayment") await overpayment();
else if (cmd === "add" && args.length >= 3) await add(args[0], args[1], args[2], args[3]);
else if (cmd === "check" && args[0]) await check(args[0]);
else console.log("Usage: npm run seed -- overpayment | add <txn id> <email> <name> [message] | check <capture id>");

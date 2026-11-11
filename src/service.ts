import { randomUUID } from "node:crypto";
import { escalate, explain } from "./ai.ts";
import { config } from "./config.ts";
import type { Store } from "./db.ts";
import { fromCents, PayPal, PayPalError, toCents, type Capture, type SearchTransaction } from "./paypal.ts";
import { assess } from "./rules.ts";
import type { Assessment, Explanation, Payment } from "./types.ts";

export type Deps = { store: Store; paypal: PayPal | null; explainFn?: typeof explain };

export class ActionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Search event codes T00xx are incoming payments (T0000 = P2P, T0006/T0007 = checkout...).
const isIncoming = (t: SearchTransaction) =>
  t.transaction_info.transaction_event_code.startsWith("T00") && Number(t.transaction_info.transaction_amount.value) > 0;

export function paymentFromSearch(t: SearchTransaction): Omit<Payment, "status" | "refundedCents" | "message"> {
  const i = t.transaction_info;
  const n = t.payer_info?.payer_name;
  return {
    id: i.transaction_id,
    payerEmail: t.payer_info?.email_address ?? null,
    payerName: n?.alternate_full_name ?? ([n?.given_name, n?.surname].filter(Boolean).join(" ") || null),
    amountCents: toCents(i.transaction_amount.value),
    currency: i.transaction_amount.currency_code,
    feeCents: i.fee_amount ? Math.abs(toCents(i.fee_amount.value)) : null,
    note: i.transaction_note ?? i.transaction_subject ?? null,
    receivedAt: new Date(i.transaction_initiation_date).toISOString(),
    source: "search",
  };
}

export function paymentFromCapture(c: Capture, source: Payment["source"]): Omit<Payment, "status" | "refundedCents" | "message"> {
  const fee = c.seller_receivable_breakdown?.paypal_fee?.value;
  return {
    id: c.id,
    payerEmail: null,
    payerName: null,
    amountCents: toCents(c.amount.value),
    currency: c.amount.currency_code,
    feeCents: fee ? toCents(fee) : null,
    note: null,
    receivedAt: new Date(c.create_time).toISOString(),
    source,
  };
}

export class Service {
  store: Store;
  paypal: PayPal | null;
  explainFn: typeof explain;

  constructor(deps: Deps) {
    this.store = deps.store;
    this.paypal = deps.paypal;
    this.explainFn = deps.explainFn ?? explain;
  }

  private requirePayPal(): PayPal {
    if (!this.paypal) throw new ActionError(400, "PayPal isn't connected (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).");
    return this.paypal;
  }

  getPayment(id: string): Payment {
    const p = this.store.getPayment(id);
    if (!p) throw new ActionError(404, "No such payment.");
    return p;
  }

  rulesFor(p: Payment): Assessment {
    return assess(p, {
      openOrders: this.store.listOrders("open"),
      knownPayers: this.store.listKnownPayers(),
      largePaymentCents: config.largePaymentCents,
    });
  }

  /** Re-run the rules and the AI explanation for one payment. */
  async analyze(id: string): Promise<{ assessment: Assessment; explanation: Explanation }> {
    const p = this.getPayment(id);
    const rules = this.rulesFor(p);
    const explanation = await this.explainFn(p, rules);
    const assessment = escalate(rules, explanation);
    this.store.saveAssessment(id, assessment, explanation);
    return { assessment, explanation };
  }

  /** Pull recent incoming payments from Transaction Search. New ones are analysed. */
  async sync(days = 7): Promise<{ added: number; seen: number }> {
    const pp = this.requirePayPal();
    const end = new Date();
    const rows = (await pp.searchTransactions(new Date(end.getTime() - days * 86_400_000), end)).filter(isIncoming);
    let added = 0;
    for (const r of rows) {
      const fresh = !this.store.getPayment(r.transaction_info.transaction_id);
      this.store.upsertPayment(paymentFromSearch(r));
      if (fresh) {
        added++;
        await this.analyze(r.transaction_info.transaction_id);
      }
    }
    return { added, seen: rows.length };
  }

  /** Add a payment by its transaction id (from the "You've got money" email). */
  async lookup(id: string, extra: { payerEmail?: string; payerName?: string; note?: string } = {}) {
    const pp = this.requirePayPal();
    const cap = await pp.getCapture(id.trim());
    this.store.upsertPayment({
      ...paymentFromCapture(cap, "lookup"),
      payerEmail: extra.payerEmail || null,
      payerName: extra.payerName || null,
      note: extra.note || null,
    });
    if (cap.status === "REFUNDED") this.store.setStatus(cap.id, "refunded");
    return this.analyze(cap.id);
  }

  /** PAYMENT.CAPTURE.COMPLETED webhook: record the payment and analyse it. */
  async onCaptureCompleted(cap: Capture) {
    this.store.upsertPayment(paymentFromCapture(cap, "webhook"));
    return this.analyze(cap.id);
  }

  async setMessage(id: string, message: string) {
    this.getPayment(id);
    this.store.setMessage(id, message.trim().slice(0, 4000) || null);
    return this.analyze(id);
  }

  /**
   * Refund part or all of the original payment. Guards:
   * - the seller must type the amount to confirm (one deliberate step before money moves),
   * - never more than what's left to refund,
   * - an idempotency key per confirmation, so a double click or retry can't refund twice.
   */
  async refund(id: string, input: { amountCents: number; confirm: string; requestKey: string }) {
    // One refund per payment at a time: two clicks racing each other would both pass the
    // checks below before either is logged, and the local refunded total would count twice.
    if (this.refunding.has(id)) throw new ActionError(409, "A refund for this payment is already in progress.");
    this.refunding.add(id);
    try {
      return await this.refundOnce(id, input);
    } finally {
      this.refunding.delete(id);
    }
  }

  private refunding = new Set<string>();

  private async refundOnce(id: string, input: { amountCents: number; confirm: string; requestKey: string }) {
    const p = this.getPayment(id);
    const remaining = p.amountCents - p.refundedCents;
    const { amountCents, confirm, requestKey } = input;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(requestKey)) throw new ActionError(400, "Missing confirmation key.");
    const requestId = `holdup-${id}-${requestKey}`.slice(0, 108);
    // A replayed confirmation (double click, retry) returns the first result instead of refunding again.
    const prior = this.store.listAudit(id).find((e) => e.requestId === requestId && e.action === "refund" && e.ok);
    if (prior) return { already: true, detail: prior.detail };

    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ActionError(400, "Refund amount must be more than zero.");
    if (amountCents > remaining) throw new ActionError(400, `You can refund at most $${fromCents(remaining)} on this payment.`);
    if (confirm.trim().replace(/^\$/, "") !== fromCents(amountCents)) throw new ActionError(400, `Type ${fromCents(amountCents)} to confirm the refund.`);

    const note = "Returned to your original payment method. I can only return money as a refund of the original PayPal payment.";
    if (config.demo || p.source === "demo") {
      this.store.addRefunded(id, amountCents);
      this.store.setStatus(id, "refunded");
      const detail = `Demo refund of $${fromCents(amountCents)} (no PayPal call: sample payment).`;
      this.store.audit({ paymentId: id, action: "refund", amountCents, requestId, ok: true, detail });
      this.closeMatchedOrder(id);
      return { already: false, detail };
    }
    const pp = this.requirePayPal();
    try {
      const r = await pp.refundCapture(id, amountCents, p.currency, requestId, note);
      this.store.addRefunded(id, amountCents);
      this.store.setStatus(id, "refunded");
      const detail = `PayPal refund ${r.id}: ${r.status}, $${fromCents(amountCents)} back to the sender's original payment method.`;
      this.store.audit({ paymentId: id, action: "refund", amountCents, requestId, ok: true, detail });
      this.closeMatchedOrder(id);
      return { already: false, detail };
    } catch (e) {
      const detail = e instanceof PayPalError ? e.message : `Refund failed: ${(e as Error).message}`;
      this.store.audit({ paymentId: id, action: "refund", amountCents, requestId, ok: false, detail });
      throw new ActionError(502, detail);
    }
  }

  private closeMatchedOrder(id: string) {
    const a = this.store.getAssessment(id)?.assessment;
    const order = a?.matchedOrderId ? this.store.listOrders().find((o) => o.id === a.matchedOrderId) : null;
    if (order) this.store.upsertOrder({ ...order, status: "paid" });
  }

  hold(id: string) {
    this.getPayment(id);
    this.store.setStatus(id, "held");
    this.store.audit({ paymentId: id, action: "hold", amountCents: null, requestId: null, ok: true, detail: "Held. No money moved." });
  }

  keep(id: string, remember?: "customer" | "payout") {
    const p = this.getPayment(id);
    this.store.setStatus(id, "kept");
    if (remember && p.payerEmail) {
      this.store.upsertKnownPayer({ email: p.payerEmail, name: p.payerName ?? p.payerEmail, kind: remember, note: "Added when you kept a payment" });
    }
    this.closeMatchedOrder(id);
    this.store.audit({ paymentId: id, action: "keep", amountCents: null, requestId: null, ok: true, detail: remember ? `Kept. Sender remembered as ${remember}.` : "Kept." });
  }

  report(id: string) {
    this.getPayment(id);
    this.store.setStatus(id, "reported");
    this.store.audit({ paymentId: id, action: "report", amountCents: null, requestId: null, ok: true, detail: "Marked as reported to PayPal. No money moved." });
    return { url: config.paypal.api.includes("sandbox") ? "https://www.sandbox.paypal.com/resolutioncenter" : "https://www.paypal.com/resolutioncenter" };
  }

  newRequestKey() {
    return randomUUID();
  }
}

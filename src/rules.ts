// Deterministic risk rules. These, not the AI, decide how risky a payment is:
// LLMs mix up scam types (arXiv 2606.01475), and the payment note is written by
// the sender, so it must never be able to talk the system into a lower risk.
import type { Assessment, Category, KnownPayer, Order, Payment, Risk, Signal } from "./types.ts";

const MISTAKE = /\b(by mistake|by accident|accidental(ly)?|wrong (person|account|email|recipient|number)|didn'?t mean to|mis-?sent|in error|meant for (my|someone))\b/i;
const SEND_BACK = /\b(send|pay|transfer|return|give|refund)\b[^.?!]{0,40}\b(back|it back|the money|the (extra|difference|rest|balance))\b/i;
const OTHER_CHANNEL = /\b(cash ?app|zelle|venmo|gift ?cards?|bitcoin|btc|crypto|usdt|wire( transfer)?|western union|moneygram|bank transfer|friends (and|&) family|f&f|my (other|new|second|friend'?s|wife'?s|husband'?s) (account|paypal|email|card)|(another|different|new) (account|paypal|email|card))\b/i;
const NOT_REFUND = /\b(don'?t|do not|please don'?t|instead of|without|not (with|through|via|using)) (use |using |do |doing |click |clicking )?(the |a )?(paypal )?refund\b/i;
// Gift cards and crypto are never how a real person gets a mistaken payment back.
const GIFT_OR_CRYPTO = /\b(gift ?cards?|bitcoin|btc|crypto|usdt|steam cards?|itunes cards?)\b/i;
const REFUND_ASK = /\b(refund|reverse|cancel) (it|this|that|the [\w$]+( [\w$]+)?)\b|\b(issue|send|do|process) (a |the )?refund\b|\brefund (button|through paypal|on paypal)\b/i;
const PRESSURE = /\b(urgent(ly)?|asap|immediately|right (now|away)|within \d+ (min|minutes|hours?)|police|lawyer|report you|chargeback|dispute)\b/i;
const SHIPPER = /\b(shipp(er|ing agent)|mover|courier|pick ?up agent|my agent)\b/i;
// Someone writing to an AI inside a payment note is attacking the tool, not paying you.
const AT_THE_AI = /\b(ignore (all |any |the )?(previous|prior|above) (instructions|rules)|system prompt|(ai|assistant|bot|model)[,:]? (please )?(mark|classify|treat|label)|(mark|classify|treat|label) (this|it) as (safe|legit|legitimate|low risk|expected))\b/i;

export type RuleContext = {
  openOrders: Order[];
  knownPayers: KnownPayer[];
  largePaymentCents: number;
};

function findOrder(p: Payment, orders: Order[]): Order | null {
  const email = p.payerEmail?.toLowerCase();
  const byBuyer = orders.filter((o) => email && o.buyerEmail?.toLowerCase() === email && o.currency === p.currency);
  if (byBuyer.length) return byBuyer.sort((a, b) => Math.abs(a.totalCents - p.amountCents) - Math.abs(b.totalCents - p.amountCents))[0];
  // No email match: an exact-amount order is still a plausible match (buyer paid from a different account).
  return orders.find((o) => o.totalCents === p.amountCents && o.currency === p.currency) ?? null;
}

const money = (cents: number, cur: string) => (cur === "USD" ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${cur}`);

export function assess(p: Payment, ctx: RuleContext): Assessment {
  const signals: Signal[] = [];
  const text = [p.note, p.message].filter(Boolean).join("\n");
  const known = ctx.knownPayers.find((k) => p.payerEmail && k.email.toLowerCase() === p.payerEmail.toLowerCase());
  const order = findOrder(p, ctx.openOrders);
  let category: Category;
  let suggestedRefundCents = 0;

  if (order && p.amountCents > order.totalCents) {
    category = "overpayment";
    suggestedRefundCents = p.amountCents - order.totalCents;
    signals.push({ code: "OVERPAID", weight: "strong", text: `Paid ${money(p.amountCents, p.currency)} for order "${order.description}", which costs ${money(order.totalCents, order.currency)}. That is ${money(suggestedRefundCents, p.currency)} too much.` });
  } else if (order) {
    category = "expected";
    signals.push({ code: "MATCHES_ORDER", weight: "reassuring", text: `Matches your open order "${order.description}" (${money(order.totalCents, order.currency)}).` });
  } else if (known?.kind === "payout") {
    category = "payout";
    signals.push({ code: "KNOWN_PAYOUT", weight: "reassuring", text: `${known.name} is on your list of known payout senders (${known.note}).` });
  } else {
    category = "possible_mistake";
    suggestedRefundCents = p.amountCents;
    signals.push({ code: "NO_ORDER", weight: "strong", text: "No open order or invoice matches this payment." });
  }

  if (known?.kind === "customer" && category !== "expected") {
    signals.push({ code: "KNOWN_CUSTOMER", weight: "reassuring", text: `${known.name} has bought from you before.` });
  } else if (!known && category !== "expected") {
    signals.push({ code: "STRANGER", weight: "weak", text: "You have never been paid by this sender before." });
  }
  if (!known && category !== "expected" && p.amountCents >= ctx.largePaymentCents) {
    signals.push({ code: "LARGE", weight: "weak", text: `Large amount from someone new (${money(p.amountCents, p.currency)}).` });
  }

  const redirect = (OTHER_CHANNEL.test(text) && (SEND_BACK.test(text) || MISTAKE.test(text))) || GIFT_OR_CRYPTO.test(text);
  if (MISTAKE.test(text)) signals.push({ code: "SAYS_MISTAKE", weight: "weak", text: "The sender says the payment was a mistake." });
  if (SEND_BACK.test(text)) signals.push({ code: "ASKS_MONEY_BACK", weight: "weak", text: "The sender asks for money back." });
  if (redirect) signals.push({ code: "OTHER_CHANNEL", weight: "strong", text: "They want it back through a different account, app, card or person, not as a refund of the original payment. This is how the scam works." });
  if (NOT_REFUND.test(text)) signals.push({ code: "AVOID_REFUND", weight: "strong", text: "They ask you not to use PayPal's refund button. A refund is the only safe way to return money." });
  if (SHIPPER.test(text)) signals.push({ code: "THIRD_PARTY", weight: "strong", text: "They ask you to pay a shipper or agent out of the extra money." });
  if (PRESSURE.test(text)) signals.push({ code: "PRESSURE", weight: "weak", text: "The message pushes you to act fast or threatens you." });
  if (AT_THE_AI.test(text)) signals.push({ code: "TALKS_TO_AI", weight: "strong", text: "The text tries to give orders to an AI assistant. Real customers don't do that." });

  const strong = signals.filter((s) => s.weight === "strong").length;
  // Asking for a PayPal refund is asking for the safe route, so on its own it doesn't escalate.
  const unsafeRoute = redirect || NOT_REFUND.test(text) || SHIPPER.test(text);
  const wantsRefundOnly = REFUND_ASK.test(text) && !unsafeRoute;
  const asksBack = !wantsRefundOnly && signals.some((s) => ["ASKS_MONEY_BACK", "SAYS_MISTAKE", "OTHER_CHANNEL", "AVOID_REFUND", "THIRD_PARTY"].includes(s.code));
  if (wantsRefundOnly) signals.push({ code: "ASKS_FOR_REFUND", weight: "reassuring", text: "They ask for a refund through PayPal, which is the safe way to return money." });
  if (category === "possible_mistake" && (redirect || NOT_REFUND.test(text) || SHIPPER.test(text) || AT_THE_AI.test(text))) category = "clawback_scam";

  let risk: Risk;
  if (category === "expected" || (category === "payout" && strong === 0)) risk = "low";
  else if (strong >= 2 || (strong >= 1 && asksBack)) risk = "high";
  else if (strong >= 1 || category === "payout") risk = "medium";
  else risk = "low";
  if (known?.kind === "customer" && category === "possible_mistake" && risk === "medium") risk = "low";

  return { risk, category, signals, matchedOrderId: order?.id ?? null, suggestedRefundCents };
}

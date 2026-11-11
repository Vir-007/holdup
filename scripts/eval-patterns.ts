// Runs Hold Up's rules over patterns/testset.json and reports what they catch.
//   npm run eval                 (the set the rules were tuned on)
//   npm run eval -- holdout.json (written after tuning, never used to change the rules)
//   add --ai to include the AI escalation layer (needs AI_API_KEY)
// The test set is written by us, so this checks the rules do what we claim;
// it is not a measure of accuracy on real-world traffic.
import { readFileSync } from "node:fs";
import { escalate, explain } from "../src/ai.ts";
import { assess } from "../src/rules.ts";
import type { KnownPayer, Order, Payment } from "../src/types.ts";

type Case = { id: string; label: "scam" | "benign"; kind: string; amount: number; order?: number; note: string | null; message: string | null };

const withAi = process.argv.includes("--ai");
const file = process.argv.slice(2).find((a) => a.endsWith(".json")) ?? "testset.json";
const { cases } = JSON.parse(readFileSync(new URL(`../patterns/${file}`, import.meta.url), "utf8")) as { cases: Case[] };
console.log(`Set: patterns/${file}${withAi ? ", rules + AI escalation" : ", rules only"}\n`);
const sender = "sender@example.com";

const rows = [];
for (const c of cases) {
  const orders: Order[] = c.order
    ? [{ id: "O", buyerEmail: sender, buyerName: "Buyer", totalCents: c.order, currency: "USD", description: "Item", status: "open", createdAt: "" }]
    : [];
  const knownPayers: KnownPayer[] =
    c.kind === "payout" ? [{ email: sender, name: "Payout", kind: "payout", note: "" }]
    : c.kind === "customer" ? [{ email: sender, name: "Customer", kind: "customer", note: "" }]
    : [];
  const p: Payment = {
    id: c.id, payerEmail: sender, payerName: "Sender", amountCents: c.amount, currency: "USD", feeCents: null,
    note: c.note, message: c.message, receivedAt: "", source: "demo", status: "new", refundedCents: 0,
  };
  let a = assess(p, { openOrders: orders, knownPayers, largePaymentCents: 20000 });
  if (withAi) a = escalate(a, await explain(p, a));
  rows.push({ c, a });
}

const scams = rows.filter((r) => r.c.label === "scam");
const benign = rows.filter((r) => r.c.label === "benign");
const caught = scams.filter((r) => r.a.risk === "high");
const falseAlarms = benign.filter((r) => r.a.risk === "high");

for (const { c, a } of rows) {
  const ok = c.label === "scam" ? a.risk === "high" : a.risk !== "high";
  console.log(`${ok ? "ok  " : "MISS"} ${c.id.padEnd(4)} ${c.label.padEnd(6)} -> ${a.risk.padEnd(6)} ${a.category.padEnd(16)} ${a.signals.map((s) => s.code).join(",")}`);
}
console.log(`\nScams flagged high risk: ${caught.length}/${scams.length}`);
console.log(`Benign payments flagged high risk (false alarms): ${falseAlarms.length}/${benign.length}`);
const unsafeSuggestions = rows.filter((r) => r.a.suggestedRefundCents > r.c.amount);
console.log(`Refund suggestions above the amount received: ${unsafeSuggestions.length}`);
if (caught.length < scams.length || falseAlarms.length > 0) process.exitCode = 1;

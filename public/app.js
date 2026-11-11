// Hold Up front end. Every string from the server goes in as text, never HTML:
// payment notes and messages are written by possible scammers.

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const plain = (cents) => (cents / 100).toFixed(2);
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

const STATE_TEXT = { new: "", held: "Held", refunded: "Refunded", kept: "Kept", reported: "Reported" };
const RISK_TEXT = { high: "High risk", medium: "Check this", low: "Looks fine" };
const FLAG_TEXT = {
  claims_mistake: "Says it was a mistake",
  asks_money_back: "Asks for money back",
  other_channel: "Wants another payment route",
  avoid_refund: "Avoids PayPal refund",
  urgency: "Rushes you",
  threat: "Threatens you",
  third_party_payment: "Wants you to pay someone else",
  sob_story: "Sad story",
  impersonation: "Pretends to be someone",
  instructions_to_ai: "Tries to instruct the AI",
};

let selected = null;
let status = {};

// ---------- Status ----------
async function loadStatus() {
  status = await api("/api/status");
  const pills = [];
  if (status.demo) pills.push(h("span", { class: "pill on" }, "Demo data"));
  else pills.push(h("span", { class: `pill ${status.paypal ? "on" : "off"}` }, status.paypal ? (status.sandbox ? "PayPal sandbox" : "PayPal live") : "PayPal not connected"));
  pills.push(h("span", { class: `pill ${status.ai ? "on" : "off"}` }, status.ai ? `AI: ${status.ai}` : "AI off, rules only"));
  $("#status").replaceChildren(...pills);
  if (status.demo) {
    $("#sync").textContent = "Reset demo";
    $("#open-lookup").hidden = true;
  }
}

// ---------- Inbox ----------
async function loadPayments() {
  const list = await api("/api/payments");
  const items = list.map((p) =>
    h("li", {},
      h("button", { class: `pay risk-${p.risk}`, "aria-current": p.id === selected ? "true" : "false", onclick: () => openCase(p.id) },
        h("span", { class: "dot", title: RISK_TEXT[p.risk] }),
        h("span", { class: "pay-who" }, p.payerName || p.payerEmail || "Unknown sender"),
        h("span", { class: "pay-amt" }, money(p.amountCents)),
        h("span", { class: "pay-label" }, h("span", {}, p.label), h("span", { class: "pay-state" }, STATE_TEXT[p.status])),
      ),
    ),
  );
  $("#payments").replaceChildren(...(items.length ? items : [h("li", { class: "empty" }, h("p", {}, "No payments yet. Check for new payments, or add one by its transaction ID."))]));
  return list;
}

// ---------- Case ----------
async function openCase(id, push = true) {
  selected = id;
  if (push) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  $("#view-payments").classList.add("showing-case");
  const data = await api(`/api/payments/${encodeURIComponent(id)}`);
  renderCase(data);
  loadPayments();
}

function renderCase({ payment: p, assessment: a, explanation: e, order, audit }) {
  const remaining = p.amountCents - p.refundedCents;
  const refundCents = Math.min(a.suggestedRefundCents || remaining, remaining);
  const settled = ["refunded", "kept", "reported"].includes(p.status);

  const actions = h("div", { class: "actions" },
    remaining > 0 && a.category !== "expected"
      ? h("button", { class: "btn safe", onclick: () => openRefund(p, refundCents) },
          `Refund ${money(refundCents)} to the original payment`,
          h("span", {}, a.category === "overpayment" ? "Returns only the extra. Safe." : "Goes back where it came from. Safe."))
      : null,
    p.status !== "held" && !settled
      ? h("button", { class: "btn ghost", onclick: () => act(p.id, "hold") }, "Hold, decide later", h("span", {}, "Nothing moves."))
      : null,
    h("button", { class: "btn ghost", onclick: () => act(p.id, "keep", p.payerEmail ? { remember: a.category === "payout" ? "payout" : "customer" } : {}) },
      a.category === "expected" ? "Mark as paid" : "It's legit, keep it",
      h("span", {}, p.payerEmail ? "Remembers this sender." : "Keeps the money.")),
    a.risk !== "low"
      ? h("button", { class: "btn ghost", onclick: () => report(p.id) }, "Report to PayPal", h("span", {}, "Opens PayPal's Resolution Center."))
      : null,
  );

  const quarantine = h("div", { class: "quarantine" },
    h("div", { class: "quarantine-inner" },
      h("div", { class: "quarantine-label" }, "Written by the sender", h("span", {}, "Hold Up treats this as evidence, never as instructions.")),
      h("div", {}, h("div", { class: "said-label" }, "Note on the payment"), h("p", { class: "said" }, p.note || "No note.")),
      p.message ? h("div", {}, h("div", { class: "said-label" }, "Message you got afterwards"), h("p", { class: "said" }, p.message)) : null,
      e?.messageFlags?.length ? h("div", { class: "flags", "aria-label": "Tactics spotted" }, e.messageFlags.map((f) => h("span", { class: "flag" }, FLAG_TEXT[f] || f))) : null,
      h("form", { class: "paste", onsubmit: (ev) => { ev.preventDefault(); saveMessage(p.id, ev.target.message.value); } },
        h("label", { class: "said-label", for: "msg" }, p.message ? "Got another message? Replace it here." : "Got an email or text about this payment? Paste it here."),
        h("textarea", { id: "msg", name: "message", placeholder: "“Hi, I sent this by mistake, can you send it back to…”" }),
        h("div", {}, h("button", { class: "btn small ghost", type: "submit" }, "Check this message")),
      ),
    ),
  );

  $("#case").replaceChildren(...[
    h("button", { class: "btn small ghost back", onclick: closeCase }, "All payments"),
    h("div", { class: "case-head" },
      h("div", {},
        h("div", { class: "amount" }, money(p.amountCents), h("small", {}, p.currency)),
        h("div", { class: "from" }, "from ", h("strong", {}, p.payerName || "unknown name"), p.payerEmail ? ` (${p.payerEmail})` : ""),
      ),
      h("div", { class: "case-meta" },
        h("div", {}, `Received ${when(p.receivedAt)}`),
        h("div", {}, `Transaction ${p.id}`),
        p.feeCents ? h("div", {}, `PayPal fee ${money(p.feeCents)}`) : null,
      ),
    ),
    h("div", { class: `verdict risk-${a.risk}` },
      h("div", { class: "verdict-risk" }, RISK_TEXT[a.risk]),
      h("div", { class: "verdict-title" }, a.label),
      e ? h("div", {}, e.summary) : h("div", {}, "Writing an explanation…"),
    ),
    settled || p.status === "held"
      ? h("p", { class: "done-banner" }, statusLine(p))
      : null,
    !settled ? actions : null,
    e?.whatToDo ? h("section", { class: "block explain" }, h("h2", {}, "What to do"), h("p", { class: "todo" }, e.whatToDo),
      h("p", { class: "by" }, e.model === "rules" ? "Written from Hold Up's rules." : `Explained by ${e.model}. Hold Up's rules set the risk level; the AI can raise it, never lower it.`)) : null,
    h("section", { class: "block" }, h("h2", {}, "Why"),
      h("ul", { class: "signals" }, a.signals.map((s) => h("li", { class: s.weight }, s.text))),
      order ? h("p", { class: "by" }, `Matched order ${order.id}: ${order.description}, ${money(order.totalCents)}.`) : null,
    ),
    h("section", { class: "block" }, quarantine),
    e?.replyDraft && !settled ? h("section", { class: "block reply" }, h("h2", {}, "Reply you can send"),
      h("textarea", { id: "reply", "aria-label": "Reply draft" }, e.replyDraft),
      h("div", {}, h("button", { class: "btn small ghost", onclick: () => navigator.clipboard.writeText($("#reply").value).then(() => toast("Reply copied.")) }, "Copy reply")),
    ) : null,
    audit.length ? h("section", { class: "block" }, h("h2", {}, "History"),
      h("ol", { class: "log" }, audit.map((x) => h("li", {}, h("time", { datetime: x.createdAt }, when(x.createdAt)), h("span", { class: x.ok ? "" : "fail" }, x.detail))))) : null,
  ].filter(Boolean));
  $("#case").focus({ preventScroll: true });
}

function closeCase() {
  $("#view-payments").classList.remove("showing-case");
  history.replaceState(null, "", location.pathname);
}

function statusLine(p) {
  if (p.status === "refunded") return `Refunded ${money(p.refundedCents)} to the sender's original payment.${p.refundedCents < p.amountCents ? ` You kept ${money(p.amountCents - p.refundedCents)}.` : ""}`;
  if (p.status === "kept") return "You kept this payment.";
  if (p.status === "reported") return "You reported this payment to PayPal. Don't send any money while PayPal looks into it.";
  if (p.status === "held") return "On hold. No money has moved. Come back when you've decided.";
  return "";
}

async function act(id, action, body) {
  try {
    renderCase(await api(`/api/payments/${encodeURIComponent(id)}/${action}`, { method: "POST", body: body ?? {} }));
    toast({ hold: "Held. No money moved.", keep: "Kept." }[action] ?? "Done.");
    loadPayments();
  } catch (err) {
    toast(err.message);
  }
}

async function report(id) {
  try {
    const r = await api(`/api/payments/${encodeURIComponent(id)}/report`, { method: "POST", body: {} });
    renderCase(r);
    window.open(r.url, "_blank", "noopener");
    loadPayments();
  } catch (err) {
    toast(err.message);
  }
}

async function saveMessage(id, message) {
  if (!message.trim()) return;
  try {
    $("#case").setAttribute("aria-busy", "true");
    renderCase(await api(`/api/payments/${encodeURIComponent(id)}/message`, { method: "POST", body: { message } }));
    loadPayments();
  } catch (err) {
    toast(err.message);
  } finally {
    $("#case").removeAttribute("aria-busy");
  }
}

// ---------- Refund dialog ----------
let refundCtx = null;
async function openRefund(p, cents) {
  const { key } = await api("/api/request-key");
  refundCtx = { id: p.id, key };
  const f = $("#refund-form");
  f.amount.value = plain(cents);
  f.confirm.value = "";
  $("#refund-error").textContent = "";
  $("#fee-note").textContent = p.feeCents
    ? `PayPal doesn't give back its ${money(p.feeCents)} fee on a refund. That's the price of returning it safely.`
    : "PayPal usually keeps its processing fee on a refund. That's the price of returning it safely.";
  $("#refund-dialog").showModal();
  f.confirm.focus();
}

$("#refund-form").addEventListener("submit", async (ev) => {
  if (ev.submitter?.value !== "ok") return;
  ev.preventDefault();
  const f = ev.target;
  const btn = $("#refund-submit");
  btn.disabled = true;
  btn.textContent = "Refunding…";
  try {
    const r = await api(`/api/payments/${encodeURIComponent(refundCtx.id)}/refund`, {
      method: "POST",
      body: { amount: f.amount.value.replace(/[$,\s]/g, ""), confirm: f.confirm.value, requestKey: refundCtx.key },
    });
    $("#refund-dialog").close();
    renderCase(r);
    loadPayments();
    toast(r.result.detail);
  } catch (err) {
    $("#refund-error").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Refund";
  }
});

// ---------- Toolbar ----------
$("#sync").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    if (status.demo) {
      await api("/api/demo/reset", { method: "POST" });
      toast("Demo reset.");
    } else {
      const r = await api("/api/sync", { method: "POST" });
      toast(r.added ? `${r.added} new payment${r.added > 1 ? "s" : ""}.` : "No new payments. PayPal can take up to 3 hours to list one; add it by transaction ID to check it now.");
    }
    await loadPayments();
    if (selected) openCase(selected, false).catch(() => {});
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#open-lookup").addEventListener("click", () => {
  const f = $("#lookup");
  f.hidden = !f.hidden;
  if (!f.hidden) f.id.focus();
});

$("#lookup").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const btn = f.querySelector("button");
  btn.disabled = true;
  try {
    const r = await api("/api/lookup", { method: "POST", body: Object.fromEntries(new FormData(f)) });
    f.reset();
    f.hidden = true;
    selected = r.payment.id;
    renderCase(r);
    loadPayments();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Other views ----------
function table(el, head, rows) {
  el.replaceChildren(
    h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))),
    h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: head.length }, "Nothing here yet."))),
  );
}

async function loadOrders() {
  const orders = await api("/api/orders");
  table($("#orders"), ["Order", "Item", "Buyer", "Total", "Status"], orders.map((o) =>
    h("tr", {}, h("td", {}, o.id), h("td", {}, o.description), h("td", {}, o.buyerName || o.buyerEmail || "Anyone"), h("td", { class: "num" }, money(o.totalCents)), h("td", {}, o.status === "open" ? "Waiting for payment" : "Paid"))));
}

async function loadSenders() {
  const s = await api("/api/known-payers");
  table($("#senders"), ["Name", "Email", "Kind", "Note"], s.map((k) =>
    h("tr", {}, h("td", {}, k.name), h("td", {}, k.email), h("td", {}, k.kind === "payout" ? "Payout sender" : "Customer"), h("td", {}, k.note))));
}

async function loadHistory() {
  const a = await api("/api/audit");
  table($("#history"), ["When", "Payment", "What happened"], a.map((x) =>
    h("tr", {}, h("td", {}, when(x.createdAt)), h("td", {}, x.paymentId), h("td", { class: x.ok ? "" : "fail" }, x.detail))));
}

for (const [formSel, path, reload] of [["#order-form", "/api/orders", loadOrders], ["#sender-form", "/api/known-payers", loadSenders]]) {
  $(formSel).addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api(path, { method: "POST", body: Object.fromEntries(new FormData(ev.target)) });
      ev.target.reset();
      reload();
      loadPayments();
    } catch (err) {
      toast(err.message);
    }
  });
}

function showView(name) {
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-current", t.dataset.view === name ? "page" : "false");
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${name}`;
  ({ orders: loadOrders, senders: loadSenders, history: loadHistory })[name]?.();
}
for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => {
  showView(t.dataset.view);
  if (t.dataset.view === "payments") $("#view-payments").classList.remove("showing-case");
});
$(".brand").addEventListener("click", (ev) => {
  ev.preventDefault();
  showView("payments");
  $("#view-payments").classList.remove("showing-case");
});

// ---------- Start ----------
await loadStatus();
const list = await loadPayments();
const fromHash = decodeURIComponent(location.hash.slice(1));
if (fromHash && list.some((p) => p.id === fromHash)) openCase(fromHash, false);
else if (list.length && matchMedia("(min-width: 761px)").matches) openCase((list.find((p) => p.status === "new" && p.risk === "high") ?? list[0]).id);
// Explanations arrive a few seconds after startup in demo mode; refresh once.
if (status.demo) setTimeout(() => { loadPayments(); if (selected) openCase(selected, false); }, 6000);

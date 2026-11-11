import { DatabaseSync } from "node:sqlite";
import type { Assessment, Explanation, KnownPayer, Order, Payment, PaymentStatus } from "./types.ts";

export type AuditEntry = {
  id: number;
  paymentId: string;
  action: string;
  amountCents: number | null;
  requestId: string | null;
  ok: boolean;
  detail: string;
  createdAt: string;
};

const SCHEMA = `
create table if not exists payments (
  id text primary key, payer_email text, payer_name text, amount_cents integer not null,
  currency text not null, fee_cents integer, note text, message text, received_at text not null,
  source text not null, status text not null default 'new', refunded_cents integer not null default 0
);
create table if not exists orders (
  id text primary key, buyer_email text, buyer_name text, total_cents integer not null,
  currency text not null, description text not null, status text not null default 'open', created_at text not null
);
create table if not exists known_payers (
  email text primary key, name text not null, kind text not null, note text not null default ''
);
create table if not exists assessments (
  payment_id text primary key, assessment text not null, explanation text, updated_at text not null
);
create table if not exists audit (
  id integer primary key autoincrement, payment_id text not null, action text not null,
  amount_cents integer, request_id text, ok integer not null, detail text not null, created_at text not null
);
`;

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

const toPayment = (r: Row): Payment => ({
  id: r.id as string,
  payerEmail: r.payer_email as string | null,
  payerName: r.payer_name as string | null,
  amountCents: r.amount_cents as number,
  currency: r.currency as string,
  feeCents: r.fee_cents as number | null,
  note: r.note as string | null,
  message: r.message as string | null,
  receivedAt: r.received_at as string,
  source: r.source as Payment["source"],
  status: r.status as PaymentStatus,
  refundedCents: r.refunded_cents as number,
});

const toOrder = (r: Row): Order => ({
  id: r.id as string,
  buyerEmail: r.buyer_email as string | null,
  buyerName: r.buyer_name as string | null,
  totalCents: r.total_cents as number,
  currency: r.currency as string,
  description: r.description as string,
  status: r.status as Order["status"],
  createdAt: r.created_at as string,
});

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  // Inserting a payment we already have keeps the seller's status and pasted message.
  upsertPayment(p: Omit<Payment, "status" | "refundedCents" | "message"> & Partial<Payment>) {
    this.db.prepare(`
      insert into payments (id, payer_email, payer_name, amount_cents, currency, fee_cents, note, message, received_at, source, status, refunded_cents)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        payer_email = coalesce(excluded.payer_email, payer_email),
        payer_name = coalesce(excluded.payer_name, payer_name),
        fee_cents = coalesce(excluded.fee_cents, fee_cents),
        note = coalesce(excluded.note, note)
    `).run(p.id, p.payerEmail, p.payerName, p.amountCents, p.currency, p.feeCents, p.note, p.message ?? null,
      p.receivedAt, p.source, p.status ?? "new", p.refundedCents ?? 0);
  }

  getPayment(id: string): Payment | null {
    const r = this.db.prepare("select * from payments where id = ?").get(id) as Row | undefined;
    return r ? toPayment(r) : null;
  }

  listPayments(): Payment[] {
    return (this.db.prepare("select * from payments order by received_at desc").all() as Row[]).map(toPayment);
  }

  setStatus(id: string, status: PaymentStatus) {
    this.db.prepare("update payments set status = ? where id = ?").run(status, id);
  }

  setMessage(id: string, message: string | null) {
    this.db.prepare("update payments set message = ? where id = ?").run(message, id);
  }

  addRefunded(id: string, cents: number) {
    this.db.prepare("update payments set refunded_cents = refunded_cents + ? where id = ?").run(cents, id);
  }

  upsertOrder(o: Order) {
    this.db.prepare(`
      insert into orders (id, buyer_email, buyer_name, total_cents, currency, description, status, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set buyer_email = excluded.buyer_email, buyer_name = excluded.buyer_name,
        total_cents = excluded.total_cents, description = excluded.description, status = excluded.status
    `).run(o.id, o.buyerEmail, o.buyerName, o.totalCents, o.currency, o.description, o.status, o.createdAt);
  }

  listOrders(status?: Order["status"]): Order[] {
    const rows = status
      ? this.db.prepare("select * from orders where status = ? order by created_at desc").all(status)
      : this.db.prepare("select * from orders order by created_at desc").all();
    return (rows as Row[]).map(toOrder);
  }

  upsertKnownPayer(k: KnownPayer) {
    this.db.prepare(`insert into known_payers (email, name, kind, note) values (?, ?, ?, ?)
      on conflict(email) do update set name = excluded.name, kind = excluded.kind, note = excluded.note`)
      .run(k.email.toLowerCase(), k.name, k.kind, k.note);
  }

  listKnownPayers(): KnownPayer[] {
    return this.db.prepare("select * from known_payers order by name").all() as KnownPayer[];
  }

  saveAssessment(paymentId: string, a: Assessment, e: Explanation | null) {
    this.db.prepare(`insert into assessments (payment_id, assessment, explanation, updated_at) values (?, ?, ?, ?)
      on conflict(payment_id) do update set assessment = excluded.assessment, explanation = excluded.explanation, updated_at = excluded.updated_at`)
      .run(paymentId, JSON.stringify(a), e ? JSON.stringify(e) : null, now());
  }

  getAssessment(paymentId: string): { assessment: Assessment; explanation: Explanation | null } | null {
    const r = this.db.prepare("select * from assessments where payment_id = ?").get(paymentId) as Row | undefined;
    if (!r) return null;
    return { assessment: JSON.parse(r.assessment as string), explanation: r.explanation ? JSON.parse(r.explanation as string) : null };
  }

  audit(e: Omit<AuditEntry, "id" | "createdAt">) {
    this.db.prepare("insert into audit (payment_id, action, amount_cents, request_id, ok, detail, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .run(e.paymentId, e.action, e.amountCents, e.requestId, e.ok ? 1 : 0, e.detail, now());
  }

  listAudit(paymentId?: string): AuditEntry[] {
    const rows = paymentId
      ? this.db.prepare("select * from audit where payment_id = ? order by id desc").all(paymentId)
      : this.db.prepare("select * from audit order by id desc limit 200").all();
    return (rows as Row[]).map((r) => ({
      id: r.id as number, paymentId: r.payment_id as string, action: r.action as string,
      amountCents: r.amount_cents as number | null, requestId: r.request_id as string | null,
      ok: r.ok === 1, detail: r.detail as string, createdAt: r.created_at as string,
    }));
  }

  reset() {
    this.db.exec("delete from payments; delete from orders; delete from known_payers; delete from assessments; delete from audit;");
  }
}

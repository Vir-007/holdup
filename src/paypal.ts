// PayPal REST client. On purpose, the only call here that moves money is
// refundCapture(): returning money to the original payment is safe, while
// "send it back" as a new payment is exactly what the scammer wants.
import { config } from "./config.ts";

export type Fetch = typeof fetch;

export class PayPalError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const b = body as { message?: string; details?: { issue?: string; description?: string }[] };
    super(`PayPal ${status}: ${b?.details?.[0]?.issue ?? b?.message ?? "request failed"}`);
    this.status = status;
    this.body = body;
  }
}

export type Capture = {
  id: string;
  status: string;
  amount: { currency_code: string; value: string };
  create_time: string;
  seller_receivable_breakdown?: { paypal_fee?: { value: string }; net_amount?: { value: string } };
};

export type Refund = { id: string; status: string; amount?: { value: string; currency_code: string } };

export type SearchTransaction = {
  transaction_info: {
    transaction_id: string;
    transaction_event_code: string;
    transaction_initiation_date: string;
    transaction_amount: { currency_code: string; value: string };
    fee_amount?: { value: string };
    transaction_status: string;
    transaction_note?: string;
    transaction_subject?: string;
  };
  payer_info?: { email_address?: string; payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string } };
};

export const toCents = (value: string) => Math.round(Number(value) * 100);
export const fromCents = (cents: number) => (cents / 100).toFixed(2);

export class PayPal {
  private token: { value: string; expires: number } | null = null;
  private fetchImpl: Fetch;
  private api: string;
  private clientId: string;
  private clientSecret: string;

  constructor(opts: { fetchImpl?: Fetch; api?: string; clientId?: string; clientSecret?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.api = opts.api ?? config.paypal.api;
    this.clientId = opts.clientId ?? config.paypal.clientId;
    this.clientSecret = opts.clientSecret ?? config.paypal.clientSecret;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.api}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json()) as { access_token: string; expires_in: number };
    if (!res.ok) throw new PayPalError(res.status, body);
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    // Network errors are retried. That's safe for refunds too: they carry a PayPal-Request-Id,
    // so PayPal returns the first result instead of refunding again.
    let res: Response | undefined;
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await this.fetchImpl(`${this.api}${path}`, {
          method,
          headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new PayPalError(res.status, parsed);
    return parsed as T;
  }

  getCapture(id: string) {
    return this.call<Capture>("GET", `/v2/payments/captures/${encodeURIComponent(id)}`);
  }

  /**
   * Refund (part of) a captured payment back to the sender's original funding source.
   * requestId makes the call idempotent: retrying with the same id never refunds twice.
   */
  refundCapture(captureId: string, amountCents: number, currency: string, requestId: string, noteToPayer: string) {
    return this.call<Refund>(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      { amount: { currency_code: currency, value: fromCents(amountCents) }, note_to_payer: noteToPayer.slice(0, 255) },
      { "PayPal-Request-Id": requestId, Prefer: "return=representation" },
    );
  }

  /** Incoming payments in a window (max 31 days). PayPal can take up to 3 hours to list a payment. */
  async searchTransactions(start: Date, end: Date): Promise<SearchTransaction[]> {
    const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "-0000");
    const out: SearchTransaction[] = [];
    for (let page = 1; page <= 10; page++) {
      const q = new URLSearchParams({ start_date: fmt(start), end_date: fmt(end), fields: "transaction_info,payer_info", page_size: "100", page: String(page) });
      const r = await this.call<{ transaction_details: SearchTransaction[]; total_pages: number }>("GET", `/v1/reporting/transactions?${q}`);
      out.push(...r.transaction_details);
      if (page >= r.total_pages) break;
    }
    return out;
  }

  /** Verify a webhook really came from PayPal (https://developer.paypal.com/api/rest/webhooks/rest/). */
  async verifyWebhook(headers: Record<string, string | undefined>, event: unknown, webhookId: string): Promise<boolean> {
    const r = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: event,
    });
    return r.verification_status === "SUCCESS";
  }
}

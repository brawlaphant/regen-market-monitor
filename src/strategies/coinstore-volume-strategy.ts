import crypto from "node:crypto";
import type { Logger } from "../logger.js";

export interface CoinstoreMarketHealth {
  volume_24h_usdt: number;
  last_price: number;
  bid_price: number;
  ask_price: number;
  spread_pct: number;
  order_book_depth_bid: number;
  order_book_depth_ask: number;
  health_score: number;
}

/**
 * Maintains healthy REGEN/USDT volume on Coinstore.
 * Two-sided market making with real spread — not wash trading.
 * Volume boost as emergency measure (explicit opt-in).
 */
export class CoinstoreVolumeStrategy {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl = "https://api.coinstore.com";
  private logger: Logger;
  private minVolume: number;
  private targetVolume: number;
  private mmSpread: number;
  private mmOrderSize: number;
  private boostEnabled: boolean;
  private boostSize: number;
  private boostsThisHour = 0;
  private boostsToday = 0;
  private lastBoostHour = -1;
  private lastBoostDay = -1;
  private lastMmRefresh = 0;
  private mmRefreshInterval: number;
  private configured = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.apiKey = process.env.COINSTORE_API_KEY || "";
    this.apiSecret = process.env.COINSTORE_API_SECRET || "";
    this.minVolume = parseFloat(process.env.COINSTORE_MIN_DAILY_VOLUME_USDT || "500");
    this.targetVolume = parseFloat(process.env.COINSTORE_TARGET_DAILY_VOLUME_USDT || "2000");
    this.mmSpread = parseFloat(process.env.COINSTORE_MM_SPREAD_PCT || "1.0");
    this.mmOrderSize = parseFloat(process.env.COINSTORE_MM_ORDER_SIZE_USDT || "25");
    this.boostEnabled = process.env.COINSTORE_VOLUME_BOOST_ENABLED === "true";
    this.boostSize = parseFloat(process.env.COINSTORE_BOOST_SIZE_USDT || "15");
    this.mmRefreshInterval = parseInt(process.env.COINSTORE_MM_REFRESH_INTERVAL_MS || "300000", 10);

    if (this.apiKey && this.apiSecret) {
      this.configured = true;
      this.logger.info("Coinstore volume strategy configured");
    } else {
      this.logger.warn("Coinstore API keys not set — volume strategy disabled");
    }
  }

  get isConfigured(): boolean { return this.configured; }

  async getMarketHealth(): Promise<CoinstoreMarketHealth | null> {
    if (!this.configured) return null;

    try {
      const ticker = await this.signedGet("/api/v1/market/ticker?symbol=REGENUSDT");
      if (!ticker) return null;

      const depth = await this.signedGet("/api/v1/market/depth?symbol=REGENUSDT");

      const vol = parseFloat(ticker.volume || ticker.vol24h || "0");
      const last = parseFloat(ticker.last || ticker.close || "0");
      const bid = parseFloat(ticker.bid || depth?.bids?.[0]?.[0] || "0");
      const ask = parseFloat(ticker.ask || depth?.asks?.[0]?.[0] || "0");
      const spread = ask > 0 ? ((ask - bid) / ask) * 100 : 0;

      const bidDepth = (depth?.bids || []).reduce((s: number, b: any) => s + parseFloat(b[1] || "0") * parseFloat(b[0] || "0"), 0);
      const askDepth = (depth?.asks || []).reduce((s: number, a: any) => s + parseFloat(a[1] || "0") * parseFloat(a[0] || "0"), 0);

      // Health score: volume (40%), spread (30%), depth symmetry (30%)
      const volScore = Math.min(vol / this.targetVolume, 1.0) * 0.4;
      const spreadScore = spread < 1 ? 0.3 : spread < 3 ? 0.15 : 0;
      const depthRatio = bidDepth > 0 && askDepth > 0 ? Math.min(bidDepth, askDepth) / Math.max(bidDepth, askDepth) : 0;
      const depthScore = depthRatio * 0.3;

      return {
        volume_24h_usdt: vol,
        last_price: last,
        bid_price: bid,
        ask_price: ask,
        spread_pct: Math.round(spread * 100) / 100,
        order_book_depth_bid: Math.round(bidDepth),
        order_book_depth_ask: Math.round(askDepth),
        health_score: Math.round((volScore + spreadScore + depthScore) * 100) / 100,
      };
    } catch (err) {
      this.logger.warn({ err: String(err) }, "Coinstore market health check failed");
      return null;
    }
  }

  async placeMarketMakingOrders(fairValue: number): Promise<void> {
    if (!this.configured || fairValue <= 0) return;

    const now = Date.now();
    if (now - this.lastMmRefresh < this.mmRefreshInterval) return;

    try {
      // Cancel existing orders first
      await this.cancelAllOrders();

      const halfSpread = this.mmSpread / 200; // pct to fraction, divided by 2
      const bidPrice = Math.round(fairValue * (1 - halfSpread) * 10000) / 10000;
      const askPrice = Math.round(fairValue * (1 + halfSpread) * 10000) / 10000;

      if (askPrice - bidPrice < fairValue * 0.005) {
        this.logger.warn("MM spread too tight (< 0.5%), skipping");
        return;
      }

      const bidQty = Math.round(this.mmOrderSize / bidPrice);
      const askQty = Math.round(this.mmOrderSize / askPrice);

      await this.placeOrder("BUY", bidPrice, bidQty);
      await this.placeOrder("SELL", askPrice, askQty);

      this.lastMmRefresh = now;
      this.logger.info({ bid: bidPrice, ask: askPrice, bidQty, askQty }, "MM orders placed");
    } catch (err) {
      this.logger.error({ err: String(err) }, "Failed to place MM orders");
    }
  }

  async runVolumeBoost(): Promise<boolean> {
    if (!this.configured || !this.boostEnabled) return false;

    // Rate limits
    const hour = new Date().getUTCHours();
    const day = new Date().getUTCDate();
    if (hour !== this.lastBoostHour) { this.boostsThisHour = 0; this.lastBoostHour = hour; }
    if (day !== this.lastBoostDay) { this.boostsToday = 0; this.lastBoostDay = day; }
    if (this.boostsThisHour >= 3 || this.boostsToday >= 10) {
      this.logger.debug("Volume boost rate limited");
      return false;
    }

    try {
      // Small market buy
      const health = await this.getMarketHealth();
      if (!health || health.ask_price <= 0) return false;

      const qty = Math.round(this.boostSize / health.ask_price);
      await this.placeOrder("BUY", 0, qty, "MARKET");

      // Limit sell slightly above to recapture
      const sellPrice = Math.round(health.last_price * 1.005 * 10000) / 10000;
      await this.placeOrder("SELL", sellPrice, qty);

      this.boostsThisHour++;
      this.boostsToday++;
      this.logger.info({ qty, boostsToday: this.boostsToday }, "Volume boost executed");
      return true;
    } catch (err) {
      this.logger.error({ err: String(err) }, "Volume boost failed");
      return false;
    }
  }

  async cancelAllOrders(): Promise<void> {
    if (!this.configured) return;
    try {
      const orders = await this.signedGet("/api/v1/trade/open-orders?symbol=REGENUSDT");
      const list = Array.isArray(orders) ? orders : orders?.orders || [];
      for (const o of list) {
        await this.signedDelete(`/api/v1/trade/order?orderId=${o.orderId || o.id}`);
      }
    } catch {}
  }

  // ─── Coinstore API helpers ────────────────────────────────────────

  private async signedGet(path: string): Promise<any> {
    const ts = Date.now().toString();
    const sig = this.sign(ts + path);
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { "X-CS-APIKEY": this.apiKey, "X-CS-SIGN": sig, "X-CS-EXPIRES": ts },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data?.data || data;
  }

  private async signedDelete(path: string): Promise<void> {
    const ts = Date.now().toString();
    const sig = this.sign(ts + path);
    await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { "X-CS-APIKEY": this.apiKey, "X-CS-SIGN": sig, "X-CS-EXPIRES": ts },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }

  private async placeOrder(side: string, price: number, qty: number, type = "LIMIT"): Promise<void> {
    const ts = Date.now().toString();
    const body = JSON.stringify({ symbol: "REGENUSDT", side, type, price: price > 0 ? price.toString() : undefined, quantity: qty.toString() });
    const sig = this.sign(ts + body);
    await fetch(`${this.baseUrl}/api/v1/trade/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CS-APIKEY": this.apiKey, "X-CS-SIGN": sig, "X-CS-EXPIRES": ts },
      body,
      signal: AbortSignal.timeout(10000),
    });
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
  }
}

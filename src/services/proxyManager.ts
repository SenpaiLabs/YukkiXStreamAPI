import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent as UndiciProxyAgent, Agent as UndiciAgent, Dispatcher } from 'undici';
import { config } from '../config.js';

export interface ProxyNode {
  url: string;
  failures: number;
  lastUsed: number;
  cooldownUntil: number;
  totalSuccess: number;
}

export class ProxyManager {
  private proxies: ProxyNode[] = [];
  private currentIndex: number = 0;
  private cooldownDurationMs: number = 5 * 60 * 1000; // 5 minutes cooldown after 429/ban

  constructor() {
    this.initProxies(config.proxies);
  }

  private initProxies(proxyUrls: string[]) {
    this.proxies = proxyUrls.map((url) => ({
      url,
      failures: 0,
      lastUsed: 0,
      cooldownUntil: 0,
      totalSuccess: 0,
    }));
  }

  public getProxyCount(): number {
    return this.proxies.length;
  }

  public getHealthyCount(): number {
    const now = Date.now();
    return this.proxies.filter((p) => p.cooldownUntil <= now).length;
  }

  /**
   * Get the next available healthy proxy
   */
  public getNextProxy(): ProxyNode | null {
    if (this.proxies.length === 0) {
      return null;
    }

    const now = Date.now();
    const available = this.proxies.filter((p) => p.cooldownUntil <= now);

    if (available.length === 0) {
      console.warn('[ProxyManager] All proxies are currently on cooldown! Forcing oldest proxy retry.');
      // Find proxy with the earliest cooldown expiry
      return this.proxies.reduce((prev, curr) =>
        prev.cooldownUntil < curr.cooldownUntil ? prev : curr
      );
    }

    // Round-robin selection among available proxies
    this.currentIndex = (this.currentIndex + 1) % available.length;
    const selected = available[this.currentIndex];
    selected.lastUsed = now;
    return selected;
  }

  /**
   * Report success for a proxy
   */
  public reportSuccess(proxyUrl: string): void {
    const node = this.proxies.find((p) => p.url === proxyUrl);
    if (node) {
      node.failures = 0;
      node.totalSuccess += 1;
      node.cooldownUntil = 0;
    }
  }

  /**
   * Report a failure / 429 / IP Block for a proxy
   */
  public reportFailure(proxyUrl: string, isBlockOr429: boolean = false): void {
    const node = this.proxies.find((p) => p.url === proxyUrl);
    if (!node) return;

    node.failures += 1;
    const now = Date.now();

    if (isBlockOr429 || node.failures >= 3) {
      // Put on cooldown
      node.cooldownUntil = now + this.cooldownDurationMs;
      console.warn(
        `[ProxyManager] Proxy ${this.maskProxyUrl(proxyUrl)} blocked or exceeded failure threshold. Cooldown for ${
          this.cooldownDurationMs / 1000
        }s.`
      );
    }
  }

  /**
   * Create an Undici Dispatcher for the given proxy URL
   */
  public createUndiciDispatcher(proxyUrl?: string): Dispatcher | undefined {
    if (!proxyUrl) return undefined;

    try {
      if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
        return new UndiciProxyAgent(proxyUrl);
      }
      // Undici doesn't natively support socks directly in ProxyAgent,
      // fallback to default agent or custom wrapper if needed.
      return undefined;
    } catch (err) {
      console.error(`[ProxyManager] Error creating undici proxy agent for ${this.maskProxyUrl(proxyUrl)}:`, err);
      return undefined;
    }
  }

  /**
   * Create an Node.js http/https Agent (compatible with standard fetch or https.request)
   */
  public createNodeAgent(proxyUrl?: string) {
    if (!proxyUrl) return undefined;

    try {
      if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://')) {
        return new SocksProxyAgent(proxyUrl);
      }
      return new HttpsProxyAgent(proxyUrl);
    } catch (err) {
      console.error(`[ProxyManager] Error creating agent for ${this.maskProxyUrl(proxyUrl)}:`, err);
      return undefined;
    }
  }

  /**
   * Mask sensitive proxy credentials for logging
   */
  public maskProxyUrl(proxyUrl: string): string {
    try {
      const url = new URL(proxyUrl);
      if (url.password) {
        url.password = '***';
      }
      return url.toString();
    } catch {
      return proxyUrl.replace(/:\/\/.*@/, '://***@');
    }
  }

  /**
   * Returns current proxy pool health status
   */
  public getStatus() {
    const now = Date.now();
    return {
      total: this.proxies.length,
      healthy: this.proxies.filter((p) => p.cooldownUntil <= now).length,
      cooldown: this.proxies.filter((p) => p.cooldownUntil > now).length,
      proxies: this.proxies.map((p) => ({
        url: this.maskProxyUrl(p.url),
        failures: p.failures,
        totalSuccess: p.totalSuccess,
        inCooldown: p.cooldownUntil > now,
        cooldownRemainingSeconds: Math.max(0, Math.round((p.cooldownUntil - now) / 1000)),
      })),
    };
  }
}

export const proxyManager = new ProxyManager();

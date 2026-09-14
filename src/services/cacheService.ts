import { config } from '../config.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class CacheService {
  private store = new Map<string, CacheEntry<any>>();

  public get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  public set<T>(key: string, value: T, ttlSeconds: number = config.cacheTtlSeconds): boolean {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public del(key: string): number {
    return this.store.delete(key) ? 1 : 0;
  }

  public getStats() {
    return { keys: this.store.size };
  }

  public flush(): void {
    this.store.clear();
  }
}

export const cacheService = new CacheService();

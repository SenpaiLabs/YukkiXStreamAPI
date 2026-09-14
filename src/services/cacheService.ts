import NodeCache from 'node-cache';
import { config } from '../config.js';

class CacheService {
  private cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({
      stdTTL: config.cacheTtlSeconds,
      checkperiod: 600,
      useClones: false,
    });
  }

  public get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  public set<T>(key: string, value: T, ttlSeconds?: number): boolean {
    if (ttlSeconds !== undefined) {
      return this.cache.set(key, value, ttlSeconds);
    }
    return this.cache.set(key, value);
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }

  public del(key: string): number {
    return this.cache.del(key);
  }

  public getStats() {
    return this.cache.getStats();
  }

  public flush(): void {
    this.cache.flushAll();
  }
}

export const cacheService = new CacheService();

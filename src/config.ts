import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  port: number;
  host: string;
  apiSecretKey?: string;
  ytClientType: 'ANDROID' | 'TV_EMBEDDED' | 'IOS' | 'WEB';
  ytPoToken?: string;
  ytVisitorData?: string;
  ytCookies?: string;
  proxies: string[];
  ipv6Subnet?: string;
  cacheTtlSeconds: number;
  enableFallback: boolean;
}

const parseProxies = (proxyString?: string): string[] => {
  if (!proxyString) return [];
  return proxyString
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
};

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  apiSecretKey: process.env.API_SECRET_KEY || undefined,
  ytClientType: (process.env.YT_CLIENT_TYPE as any) || 'ANDROID',
  ytPoToken: process.env.YT_PO_TOKEN || undefined,
  ytVisitorData: process.env.YT_VISITOR_DATA || undefined,
  ytCookies: process.env.YT_COOKIES || undefined,
  proxies: parseProxies(process.env.PROXIES),
  ipv6Subnet: process.env.IPV6_SUBNET || undefined,
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '14400', 10),
  enableFallback: process.env.ENABLE_FALLBACK === 'true',
};

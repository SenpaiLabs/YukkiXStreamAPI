import { Innertube, ClientType, UniversalCache } from 'youtubei.js';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { proxyManager } from './proxyManager.js';
import { cacheService } from './cacheService.js';
import { fallbackService, FallbackTrack } from './fallbackService.js';

export interface SearchResultItem {
  id: string;
  title: string;
  duration?: number;
  durationText?: string;
  author: string;
  authorId?: string;
  thumbnail?: string;
  views?: string;
  url: string;
}

export interface StreamDataResult {
  stream?: Readable;
  directUrl?: string;
  mimeType?: string;
  bitrate?: number;
  contentLength?: number;
  source: 'youtube' | 'jiosaavn' | 'soundcloud';
  title?: string;
  artist?: string;
  thumbnail?: string;
}

export class YouTubeService {
  private innertube: Innertube | null = null;
  private isInitializing: boolean = false;
  private initPromise: Promise<Innertube> | null = null;

  /**
   * Resolve ClientType from string config
   */
  private resolveClientType(typeStr: string): ClientType {
    switch (typeStr.toUpperCase()) {
      case 'TV_EMBEDDED':
        return ClientType.TV_EMBEDDED;
      case 'IOS':
        return ClientType.IOS;
      case 'WEB':
        return ClientType.WEB;
      case 'ANDROID':
      default:
        return ClientType.ANDROID;
    }
  }

  /**
   * Initializes or gets the active InnerTube instance with anti-ban settings
   */
  public async getInstance(): Promise<Innertube> {
    if (this.innertube) {
      return this.innertube;
    }

    if (this.isInitializing && this.initPromise) {
      return this.initPromise;
    }

    this.isInitializing = true;
    this.initPromise = (async () => {
      try {
        console.log('[YouTubeService] Initializing InnerTube session...');

        // Custom fetch wrapper to route requests through rotating proxies and catch 429
        const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const proxy = proxyManager.getNextProxy();
          const modifiedInit: RequestInit = { ...init };

          if (proxy) {
            const agent = proxyManager.createNodeAgent(proxy.url);
            if (agent) {
              (modifiedInit as any).agent = agent;
            }
          }

          try {
            const res = await fetch(input as any, modifiedInit);

            if (res.status === 429) {
              console.warn(`[YouTubeService] Received HTTP 429 (Rate Limited / IP Ban) from YouTube.`);
              if (proxy) {
                proxyManager.reportFailure(proxy.url, true);
              }
            } else if (res.ok && proxy) {
              proxyManager.reportSuccess(proxy.url);
            }

            return res;
          } catch (err) {
            if (proxy) {
              proxyManager.reportFailure(proxy.url, false);
            }
            throw err;
          }
        };

        const clientType = this.resolveClientType(config.ytClientType);
        console.log(`[YouTubeService] Using spoofed client type: ${clientType}`);

        const yt = await Innertube.create({
          client_type: clientType,
          retrieve_player: true,
          generate_session_locally: true,
          cache: new UniversalCache(true),
          cookie: config.ytCookies,
          po_token: config.ytPoToken,
          visitor_data: config.ytVisitorData,
          fetch: config.proxies.length > 0 ? (customFetch as any) : undefined,
        });

        console.log('[YouTubeService] InnerTube successfully initialized and ready!');
        this.innertube = yt;
        return yt;
      } catch (err) {
        console.error('[YouTubeService] Failed to initialize InnerTube session:', err);
        throw err;
      } finally {
        this.isInitializing = false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Search songs with caching and anti-ban retry logic
   */
  public async search(query: string, limit: number = 10): Promise<SearchResultItem[]> {
    const cacheKey = `yt:search:${query.toLowerCase().trim()}`;
    const cached = cacheService.get<SearchResultItem[]>(cacheKey);
    if (cached) {
      return cached.slice(0, limit);
    }

    try {
      const yt = await this.getInstance();
      const searchRes = await yt.search(query, { type: 'video' });

      const videos = (searchRes.videos || []).slice(0, limit);
      const results: SearchResultItem[] = [];

      for (const item of videos as any[]) {
        if (item.id) {
          results.push({
            id: item.id,
            title: item.title?.text || item.title || 'Unknown Title',
            duration: item.duration?.seconds,
            durationText: item.duration?.text,
            author: item.author?.name || 'Unknown Author',
            authorId: item.author?.id,
            thumbnail: item.thumbnails?.[0]?.url || item.thumbnail?.url,
            views: item.view_count?.text,
            url: `https://www.youtube.com/watch?v=${item.id}`,
          });
        }
      }

      if (results.length > 0) {
        cacheService.set(cacheKey, results);
        return results;
      }
    } catch (err: any) {
      console.warn(`[YouTubeService] Search failed for "${query}":`, err?.message || err);
    }

    // If YouTube fails or returned 0 results, fallback to JioSaavn if enabled
    if (config.enableFallback) {
      const fallback = await fallbackService.getFallbackTrack(query);
      if (fallback) {
        return [
          {
            id: fallback.id,
            title: fallback.title,
            duration: fallback.duration,
            durationText: `${Math.floor(fallback.duration / 60)}:${(fallback.duration % 60)
              .toString()
              .padStart(2, '0')}`,
            author: fallback.artist,
            thumbnail: fallback.thumbnail,
            views: 'Verified Stream',
            url: fallback.streamUrl,
          },
        ];
      }
    }

    return [];
  }

  /**
   * Get Video Metadata
   */
  public async getInfo(videoId: string) {
    const cacheKey = `yt:info:${videoId}`;
    const cached = cacheService.get<any>(cacheKey);
    if (cached) return cached;

    const yt = await this.getInstance();
    const info = await yt.getBasicInfo(videoId);
    const basic = info.basic_info;

    const data = {
      id: basic.id,
      title: basic.title,
      description: basic.short_description,
      duration: basic.duration,
      author: basic.author,
      channelId: basic.channel_id,
      thumbnails: basic.thumbnail,
      viewCount: basic.view_count,
    };

    cacheService.set(cacheKey, data);
    return data;
  }

  /**
   * Stream audio directly (pipes YouTube audio chunks directly to the response)
   * This bypasses the YouTube IP-binding block because your API server handles the download
   * and feeds raw audio stream directly to the Telegram bot / ffmpeg / tgcalls.
   */
  public async getAudioStream(videoId: string, songTitleHint?: string): Promise<StreamDataResult> {
    try {
      const yt = await this.getInstance();

      // Download highest quality audio using spoofed client (ANDROID)
      const webStream = await yt.download(videoId, {
        type: 'audio',
        quality: 'best',
        client: this.resolveClientType(config.ytClientType) as any,
      });

      // Convert Web ReadableStream to Node.js Readable stream
      const nodeStream = Readable.fromWeb(webStream as any);

      return {
        stream: nodeStream,
        source: 'youtube',
      };
    } catch (err: any) {
      console.error(`[YouTubeService] Audio download failed for ${videoId}:`, err?.message || err);

      // Trigger automatic Fallback if available
      if (config.enableFallback) {
        const query = songTitleHint || videoId;
        console.log(`[YouTubeService] Triggering Fallback provider for "${query}"...`);
        const fallback = await fallbackService.getFallbackTrack(query);

        if (fallback) {
          // Fetch remote audio stream from fallback provider
          const fbRes = await fetch(fallback.streamUrl);
          if (fbRes.ok && fbRes.body) {
            const fbStream = Readable.fromWeb(fbRes.body as any);
            return {
              stream: fbStream,
              source: fallback.source,
              title: fallback.title,
              artist: fallback.artist,
              thumbnail: fallback.thumbnail,
            };
          }
        }
      }

      throw new Error(`Failed to stream audio for ${videoId}: ${err?.message || 'Unknown error'}`);
    }
  }

  /**
   * Get direct streaming playback URL
   */
  public async getDirectPlaybackUrl(videoId: string): Promise<string> {
    const cacheKey = `yt:directurl:${videoId}`;
    const cached = cacheService.get<string>(cacheKey);
    if (cached) return cached;

    try {
      const yt = await this.getInstance();
      const format = await yt.getStreamingData(videoId, {
        type: 'audio',
        quality: 'best',
        client: this.resolveClientType(config.ytClientType) as any,
      });

      if (!format || !format.url) {
        throw new Error('Could not decipher direct audio playback format URL.');
      }

      // Cache for 2 hours (YouTube URLs typically expire in 6 hours)
      cacheService.set(cacheKey, format.url, 7200);
      return format.url;
    } catch (err: any) {
      console.warn(`[YouTubeService] Failed to extract direct URL for ${videoId}:`, err?.message);
      throw err;
    }
  }

  /**
   * Force refresh session (useful when changing proxies or rotating cookies)
   */
  public async refreshSession(): Promise<void> {
    console.log('[YouTubeService] Refreshing InnerTube session...');
    this.innertube = null;
    await this.getInstance();
  }
}

export const youtubeService = new YouTubeService();

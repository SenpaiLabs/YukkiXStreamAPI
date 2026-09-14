import { Request, Response } from 'express';
import { youtubeService } from '../services/youtubeService.js';
import { proxyManager } from '../services/proxyManager.js';
import { cacheService } from '../services/cacheService.js';
import { fallbackService } from '../services/fallbackService.js';
import { config } from '../config.js';

export class StreamController {
  /**
   * Health Check and Proxy Status
   */
  public async getHealth(req: Request, res: Response): Promise<void> {
    const proxyStatus = proxyManager.getStatus();
    const cacheStats = cacheService.getStats();

    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptime: process.uptime(),
      clientType: config.ytClientType,
      fallbackEnabled: config.enableFallback,
      proxies: proxyStatus,
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Primary Stream Resolver for YukkiMusic
   * GET /stream?url=<id_or_url>&format=audio
   *
   * YukkiMusic expects:
   * {
   *   "success": true,
   *   "data": {
   *     "streamUrl": "http://<host>/pipe/<id>",
   *     "title": "...",
   *     "quality": "320kbps",
   *     "duration": 213,
   *     "thumbnail": "...",
   *     "artist": "..."
   *   }
   * }
   */
  public async resolveStream(req: Request, res: Response): Promise<void> {
    const queryOrUrl = (req.query.url as string) || (req.query.q as string);
    const format = (req.query.format as string) || 'audio';

    if (!queryOrUrl || queryOrUrl.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Query parameter "url" is required.',
      });
      return;
    }

    try {
      // 1. Resolve videoId and basic info
      const videoInfo = await youtubeService.resolveTrack(queryOrUrl.trim());

      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.get('host') || `${config.host}:${config.port}`;
      const baseUrl = `${protocol}://${host}`;

      const pipeUrl = `${baseUrl}/pipe/${videoInfo.id}?title=${encodeURIComponent(videoInfo.title)}`;

      res.json({
        success: true,
        data: {
          streamUrl: pipeUrl,
          title: videoInfo.title,
          quality: '320kbps',
          duration: videoInfo.duration || 0,
          thumbnail: videoInfo.thumbnail || '',
          artist: videoInfo.author || 'Unknown Artist',
        },
      });
    } catch (err: any) {
      console.error('[StreamController] Resolve stream error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to resolve stream.',
      });
    }
  }

  /**
   * Search songs (supports both ?query= and ?q= for YukkiMusic)
   * GET /search?query=<text>&limit=5&platform=youtube
   */
  public async search(req: Request, res: Response): Promise<void> {
    const query = (req.query.query as string) || (req.query.q as string);
    const limit = parseInt((req.query.limit as string) || '5', 10);
    const platform = (req.query.platform as string) || 'youtube';

    if (!query || query.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Query parameter "query" or "q" is required.' });
      return;
    }

    try {
      const results = await youtubeService.search(query, limit);

      res.json({
        success: true,
        query,
        count: results.length,
        results,
      });
    } catch (err: any) {
      console.error('[StreamController] Search error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Internal error occurred during search.',
      });
    }
  }

  /**
   * Autoplay recommendations for continuous radio
   * GET /autoplay?url=<id_or_url>&limit=5
   */
  public async getAutoplay(req: Request, res: Response): Promise<void> {
    const queryOrUrl = (req.query.url as string) || (req.query.id as string);
    const limit = parseInt((req.query.limit as string) || '5', 10);

    if (!queryOrUrl) {
      res.status(400).json({ success: false, error: 'Parameter "url" is required.' });
      return;
    }

    try {
      const autoplayList = await youtubeService.getAutoplayList(queryOrUrl, limit);
      res.json({
        success: true,
        autoplay: autoplayList,
      });
    } catch (err: any) {
      console.error('[StreamController] Autoplay error:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to retrieve autoplay tracks.',
      });
    }
  }

  /**
   * Direct Audio Pipe (Handles PyTgCalls, ffmpeg, and curl -I HEAD requests)
   * GET /pipe/:id OR GET /api/stream/:id
   */
  public async pipeAudio(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const titleHint = req.query.title as string | undefined;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    // CRITICAL: Handle HTTP HEAD requests (e.g. curl -I or PyTgCalls probe)
    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', 'audio/webm');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).end();
      return;
    }

    try {
      const streamResult = await youtubeService.getAudioStream(id, titleHint);

      if (!streamResult.stream) {
        res.status(404).json({ error: 'Stream could not be extracted.' });
        return;
      }

      res.setHeader('Content-Type', 'audio/webm');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Stream-Source', streamResult.source);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      if (streamResult.title) {
        res.setHeader('X-Track-Title', encodeURIComponent(streamResult.title));
      }

      // Handle client disconnect gracefully
      req.on('close', () => {
        if (streamResult.stream && !streamResult.stream.destroyed) {
          streamResult.stream.destroy();
        }
      });

      // Stream chunks directly
      streamResult.stream.pipe(res);
    } catch (err: any) {
      console.error(`[StreamController] Pipe error for ${id}:`, err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: err.message || 'Failed to stream audio.',
        });
      }
    }
  }

  /**
   * Video metadata info
   * GET /api/info/:id
   */
  public async getInfo(req: Request, res: Response): Promise<void> {
    const id = req.params.id;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    try {
      const info = await youtubeService.getInfo(id);
      res.json({ success: true, data: info });
    } catch (err: any) {
      console.error(`[StreamController] GetInfo error for ${id}:`, err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to retrieve video metadata.',
      });
    }
  }
}

export const streamController = new StreamController();

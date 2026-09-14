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
   * GET /pipe/:id OR GET /stream/:id
   */
  public async pipeAudio(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const titleHint = req.query.title as string | undefined;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    // 1. Resolve title
    let title = titleHint;
    if (!title) {
      try {
        const info = await youtubeService.resolveTrack(id);
        title = info.title;
      } catch {
        title = id;
      }
    }

    // 2. Fetch direct playable stream URL
    const cleanSearchQuery = youtubeService.cleanTitle(title || id);
    const streamUrl = await fallbackService.getDirectStream(cleanSearchQuery);

    if (!streamUrl) {
      res.status(500).json({ success: false, error: `Could not extract stream for ${id}` });
      return;
    }

    // CRITICAL: Handle HTTP HEAD requests (e.g. curl -I or PyTgCalls probe)
    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', 'audio/webm');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Location', streamUrl);
      res.status(200).end();
      return;
    }

    // 3. Redirect PyTgCalls/ffmpeg directly to CDN stream (0 VPS load, max speed, 302 Found)
    res.redirect(302, streamUrl);
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

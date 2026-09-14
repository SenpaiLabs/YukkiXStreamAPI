import { Request, Response } from 'express';
import { youtubeService } from '../services/youtubeService.js';
import { proxyManager } from '../services/proxyManager.js';
import { cacheService } from '../services/cacheService.js';
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
      uptime: process.uptime(),
      clientType: config.ytClientType,
      fallbackEnabled: config.enableFallback,
      proxies: proxyStatus,
      cache: cacheStats,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Search songs
   * Query: ?q=alan+walker&limit=10
   */
  public async search(req: Request, res: Response): Promise<void> {
    const query = req.query.q as string;
    const limit = parseInt((req.query.limit as string) || '10', 10);

    if (!query || query.trim().length === 0) {
      res.status(400).json({ error: 'Query parameter "q" is required.' });
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
   * Get Video Metadata
   * Param: :id (YouTube video ID)
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

  /**
   * Audio Stream Pipe Endpoint (Bypasses YouTube IP block for Telegram voice chat)
   * Param: :id (YouTube video ID)
   * Query: ?title=Optional+Song+Title (used as a hint for fallback if YouTube fails)
   */
  public async streamAudio(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const titleHint = req.query.title as string | undefined;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    try {
      const streamResult = await youtubeService.getAudioStream(id, titleHint);

      if (!streamResult.stream) {
        res.status(404).json({ error: 'Stream could not be extracted.' });
        return;
      }

      // Set audio headers for Telegram streaming / ffmpeg
      res.setHeader('Content-Type', 'audio/webm');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Stream-Source', streamResult.source);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      if (streamResult.title) {
        res.setHeader('X-Track-Title', encodeURIComponent(streamResult.title));
      }

      // Handle client abort / disconnect (stop pulling from YouTube)
      req.on('close', () => {
        if (streamResult.stream && !streamResult.stream.destroyed) {
          streamResult.stream.destroy();
        }
      });

      // Pipe chunked audio stream
      streamResult.stream.pipe(res);
    } catch (err: any) {
      console.error(`[StreamController] Stream error for ${id}:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: err.message || 'Failed to stream audio.',
        });
      }
    }
  }

  /**
   * Get direct playback URL
   * Param: :id (YouTube video ID)
   */
  public async getDirectUrl(req: Request, res: Response): Promise<void> {
    const id = req.params.id;

    if (!id) {
      res.status(400).json({ error: 'Parameter "id" is required.' });
      return;
    }

    try {
      const directUrl = await youtubeService.getDirectPlaybackUrl(id);
      res.json({
        success: true,
        id,
        url: directUrl,
      });
    } catch (err: any) {
      console.error(`[StreamController] Direct URL error for ${id}:`, err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to get direct playback URL.',
      });
    }
  }

  /**
   * Force refresh session / proxies
   */
  public async refreshSession(req: Request, res: Response): Promise<void> {
    try {
      await youtubeService.refreshSession();
      res.json({ success: true, message: 'Session refreshed successfully.' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

export const streamController = new StreamController();

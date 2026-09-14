import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { streamController } from './controllers/streamController.js';
import { youtubeService } from './services/youtubeService.js';

const app = express();

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Optional API Key Authentication Middleware
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if (!config.apiSecretKey) {
    return next();
  }

  const headerKey = req.headers['x-api-key'] || req.headers['authorization'];
  const queryKey = req.query.api_key as string;

  const token = headerKey
    ? (Array.isArray(headerKey) ? headerKey[0] : headerKey).replace('Bearer ', '').trim()
    : queryKey;

  if (token !== config.apiSecretKey) {
    res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API secret key.' });
    return;
  }

  next();
};

// Public Endpoints
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'YukkiXStreamAPI',
    version: '1.0.0',
    description: 'High-Performance Anti-IP-Ban YouTube Streaming API for YukkiMusic & Telegram Music Bots',
    endpoints: {
      health: 'GET /health',
      stream: 'GET /stream?url=<query_or_url>&format=audio',
      pipe: 'GET /pipe/:id',
      search: 'GET /search?query=<text>&limit=5',
      autoplay: 'GET /autoplay?url=<id_or_url>&limit=5',
    },
  });
});

app.get('/health', (req, res) => streamController.getHealth(req, res));

// YukkiMusic Native Endpoints (Matches anony/core/api.py exactly)
app.get('/stream', authMiddleware, (req, res) => {
  // If ?url= is passed, return JSON stream metadata for YukkiMusic
  if (req.query.url || req.query.q) {
    return streamController.resolveStream(req, res);
  }
  res.status(400).json({ success: false, error: 'Query parameter "url" is required.' });
});

app.get('/search', authMiddleware, (req, res) => streamController.search(req, res));
app.get('/autoplay', authMiddleware, (req, res) => streamController.getAutoplay(req, res));

// Direct Audio Pipe for PyTgCalls / ffmpeg
app.get('/pipe/:id', (req, res) => streamController.pipeAudio(req, res));
app.get('/stream/:id', (req, res) => streamController.pipeAudio(req, res));

// Legacy /api Routes
app.get('/api/search', authMiddleware, (req, res) => streamController.search(req, res));
app.get('/api/info/:id', authMiddleware, (req, res) => streamController.getInfo(req, res));
app.get('/api/stream/:id', (req, res) => streamController.pipeAudio(req, res));

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Server] Unhandled Exception:', err);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: 'An unexpected server error occurred.',
      message: err.message,
    });
  }
});

// Start Server
const startServer = async () => {
  try {
    console.log(`[YukkiXStreamAPI] Starting service on ${config.host}:${config.port}...`);
    console.log(`[YukkiXStreamAPI] Pre-warming YouTube InnerTube session...`);

    youtubeService.getInstance().catch((err) => {
      console.warn('[YukkiXStreamAPI] Background session warmup notice:', err.message);
    });

    const server = app.listen(config.port, config.host, () => {
      console.log(`[YukkiXStreamAPI] Server listening at http://${config.host}:${config.port}`);
    });

    const shutdown = () => {
      console.log('[YukkiXStreamAPI] Shutting down gracefully...');
      server.close(() => {
        console.log('[YukkiXStreamAPI] Server closed.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('[YukkiXStreamAPI] Failed to start server:', err);
    process.exit(1);
  }
};

startServer();

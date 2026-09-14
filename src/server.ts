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
    res.status(401).json({ error: 'Unauthorized: Invalid or missing API secret key.' });
    return;
  }

  next();
};

// Public Endpoints
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'YukkiXStreamAPI',
    version: '1.0.0',
    description: 'High-Performance Anti-IP-Ban YouTube Streaming API for Telegram Music Bots',
    endpoints: {
      health: 'GET /health',
      search: 'GET /api/search?q=query&limit=10',
      info: 'GET /api/info/:id',
      stream: 'GET /api/stream/:id',
      directUrl: 'GET /api/direct-url/:id',
      refreshSession: 'POST /api/refresh-session',
    },
  });
});

app.get('/health', (req, res) => streamController.getHealth(req, res));

// Protected API routes
app.get('/api/search', authMiddleware, (req, res) => streamController.search(req, res));
app.get('/api/info/:id', authMiddleware, (req, res) => streamController.getInfo(req, res));
app.get('/api/stream/:id', authMiddleware, (req, res) => streamController.streamAudio(req, res));
app.get('/api/direct-url/:id', authMiddleware, (req, res) => streamController.getDirectUrl(req, res));
app.post('/api/refresh-session', authMiddleware, (req, res) => streamController.refreshSession(req, res));

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Server] Unhandled Exception:', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'An unexpected server error occurred.',
      message: err.message,
    });
  }
});

// Pre-warm YouTube session and start listening
const startServer = async () => {
  try {
    console.log(`[YukkiXStreamAPI] Starting service on ${config.host}:${config.port}...`);
    console.log(`[YukkiXStreamAPI] Configured spoof client: ${config.ytClientType}`);
    console.log(`[YukkiXStreamAPI] Proxies configured: ${config.proxies.length}`);

    // Pre-warm the InnerTube session in background so the first user doesn't wait
    youtubeService.getInstance().catch((err) => {
      console.warn('[YukkiXStreamAPI] Background session warmup warning:', err.message);
    });

    const server = app.listen(config.port, config.host, () => {
      console.log(`[YukkiXStreamAPI] Server listening at http://${config.host}:${config.port}`);
    });

    // Graceful shutdown
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

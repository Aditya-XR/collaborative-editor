import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Y = require('yjs');
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils';

import connectDB from './config/db.js';
import apiRouter from './routes/api.js';
import Document from './models/Document.js';

// C++ namespace std naming equivalents for clean scope lookup
const { log, error } = console;
const { stringify, parse } = JSON;
const { now } = Date;
const { applyUpdate, encodeStateAsUpdate } = Y;

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRouter);

// Fallback error handler
app.use((err, req, res, next) => {
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  res.status(statusCode).json({
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
});

// Create HTTP server
const server = createServer(app);

// Initialize Upstash Redis for Socket.io adapter & caching
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
const redisClient = createClient({ url: process.env.REDIS_URL });

pubClient.on('error', (err) => error('Redis Pub Client Error:', err));
subClient.on('error', (err) => error('Redis Sub Client Error:', err));
redisClient.on('error', (err) => error('Redis Client Error:', err));

// Connect all Redis clients
await Promise.all([
  pubClient.connect(),
  subClient.connect(),
  redisClient.connect()
]);
log('Connected to Upstash Redis for adapter and caching.');

// Attach Socket.io Server with Redis Adapter
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});
io.adapter(createAdapter(pubClient, subClient));

// Setup Yjs WebSockets Server on the same HTTP server
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const docName = urlParts[urlParts.length - 1].split('?')[0];
  setupWSConnection(ws, req, { docName });
});

// Intercept server upgrades to route /yjs websocket traffic
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname.startsWith('/yjs')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

// Configure custom Yjs database persistence layer to MongoDB
setPersistence({
  bindState: async (docName, ydoc) => {
    try {
      const doc = await Document.findById(docName);
      if (doc && doc.data) {
        // Apply persisted Yjs binary update representation if exists
        if (doc.data instanceof Uint8Array || Buffer.isBuffer(doc.data)) {
          applyUpdate(ydoc, new Uint8Array(doc.data));
        }
      } else {
        // Create document in database if it doesn't exist
        await Document.create({ _id: docName, title: 'Untitled Document' });
      }
    } catch (err) {
      error('Yjs persistence bindState error:', err);
    }

    // Set listener on ydoc modifications to save back to database
    ydoc.on('update', async (update) => {
      try {
        const stateUpdate = encodeStateAsUpdate(ydoc);
        await Document.findByIdAndUpdate(
          docName,
          { data: Buffer.from(stateUpdate) },
          { upsert: true }
        );
      } catch (err) {
        error('Yjs persistence update save error:', err);
      }
    });
  },
  writeState: async (docName, ydoc) => {
    try {
      const stateUpdate = encodeStateAsUpdate(ydoc);
      await Document.findByIdAndUpdate(
        docName,
        { data: Buffer.from(stateUpdate) },
        { upsert: true }
      );
    } catch (err) {
      error('Yjs persistence writeState error:', err);
    }
  }
});

// Socket.io presence, cursor tracking and metadata signaling logic
io.on('connection', (socket) => {
  log(`Socket.io client connected: ${socket.id}`);
  let currentRoom = null;

  socket.on('join-document', async ({ documentId, username, color }) => {
    socket.join(documentId);
    currentRoom = documentId;
    log(`User ${socket.id} (${username}) joined presence room: ${documentId}`);

    const presenceData = {
      socketId: socket.id,
      username,
      color,
      cursor: null,
      updatedAt: now()
    };
    
    // Store user presence inside Upstash Redis hash
    await redisClient.hSet(`presence:${documentId}`, socket.id, stringify(presenceData));
    await broadcastPresence(documentId);
  });

  socket.on('cursor-move', async ({ documentId, range }) => {
    const rawData = await redisClient.hGet(`presence:${documentId}`, socket.id);
    if (rawData) {
      const presenceData = parse(rawData);
      presenceData.cursor = range;
      presenceData.updatedAt = now();
      await redisClient.hSet(`presence:${documentId}`, socket.id, stringify(presenceData));
      await broadcastPresence(documentId);
    }
  });

  // Real-time Title Change Sync
  socket.on('send-title-changes', (title) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('receive-title-changes', title);
    }
  });

  socket.on('save-title', async ({ documentId, title }) => {
    await Document.findByIdAndUpdate(documentId, { title });
  });

  // Cleanup presence on disconnect
  socket.on('disconnect', async () => {
    log(`Socket.io client disconnected: ${socket.id}`);
    if (currentRoom) {
      await redisClient.hDel(`presence:${currentRoom}`, socket.id);
      await broadcastPresence(currentRoom);
    }
  });

  // Helper function to query all presence hashes from Redis and broadcast to the room
  async function broadcastPresence(documentId) {
    try {
      const presencesRaw = await redisClient.hGetAll(`presence:${documentId}`);
      const activeUsers = [];
      for (const socketId in presencesRaw) {
        try {
          const user = parse(presencesRaw[socketId]);
          // Clean up stale client details older than 2 minutes
          if (now() - user.updatedAt < 120000) {
            activeUsers.push(user);
          } else {
            await redisClient.hDel(`presence:${documentId}`, socketId);
          }
        } catch (e) {
          error('Error parsing user presence json:', e);
        }
      }
      io.to(documentId).emit('presence-update', activeUsers);
    } catch (err) {
      error('Error broadcasting presence list:', err);
    }
  }
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
}); // Force restart trigger 3

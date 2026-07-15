import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
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
import User from './models/User.js';

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
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

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
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true
  },
});
io.adapter(createAdapter(pubClient, subClient));

// Socket.io JWT Authentication Middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication error: Token required'));
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded._id).select('-password -refreshTokens');
    if (!user) {
      return next(new Error('Authentication error: User not found'));
    }
    socket.user = user;
    next();
  } catch (err) {
    error('Socket auth error:', err);
    return next(new Error('Authentication error: Invalid token'));
  }
});

// Setup Yjs WebSockets Server on the same HTTP server
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const docName = urlParts[urlParts.length - 1].split('?')[0];
  setupWSConnection(ws, req, { docName });
});

// Intercept server upgrades to route /yjs websocket traffic (with JWT authorization check)
server.on('upgrade', (request, socket, head) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = urlObj;
  
  if (pathname.startsWith('/yjs')) {
    const token = urlObj.searchParams.get('token');
    if (!token) {
      log('Yjs upgrade rejected: No token provided');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (err) {
      log('Yjs upgrade rejected: Invalid/Expired token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  } else {
    socket.destroy();
  }
});

// Configure custom Yjs database persistence layer to MongoDB
setPersistence({
  bindState: async (docName, ydoc) => {
    try {
      const doc = await Document.findById(docName);
      if (doc && doc.data) {
        // Apply persisted Yjs binary update representation if exists
        let updateData = doc.data;
        if (doc.data.buffer && Buffer.isBuffer(doc.data.buffer)) {
          updateData = doc.data.buffer;
        }
        
        if (updateData instanceof Uint8Array || Buffer.isBuffer(updateData)) {
          applyUpdate(ydoc, new Uint8Array(updateData));
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
  log(`Socket.io client connected: ${socket.id} (User: ${socket.user.name})`);
  let currentRoom = null;

  socket.on('join-document', async ({ documentId }) => {
    try {
      // Validate document access or assign ownership/collaboration
      const document = await Document.findById(documentId);
      if (document) {
        const userIdStr = socket.user._id.toString();
        const ownerIdStr = document.owner ? document.owner.toString() : null;
        
        if (ownerIdStr !== userIdStr) {
          const isCollaborator = document.collaborators.some(cId => cId.toString() === userIdStr);
          if (!isCollaborator) {
            document.collaborators.push(socket.user._id);
            await document.save();
          }
        }
      } else {
        // Document does not exist in DB yet, create it with this user as owner
        await Document.create({
          _id: documentId,
          title: 'Untitled Document',
          owner: socket.user._id,
          collaborators: []
        });
      }
    } catch (err) {
      error('Socket join document verification error:', err);
    }

    socket.join(documentId);
    currentRoom = documentId;
    log(`User ${socket.id} (${socket.user.name}) joined presence room: ${documentId}`);

    const presenceData = {
      socketId: socket.id,
      username: socket.user.name,
      color: socket.user.color,
      avatar: socket.user.avatar || '',
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

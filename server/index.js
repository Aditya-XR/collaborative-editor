import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import connectDB from './config/db.js';
import apiRouter from './routes/api.js';
import Document from './models/Document.js';

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

// Wrap express server
const server = createServer(app);

// Attach Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const DEFAULT_VALUE = '';

async function findOrCreateDocument(id) {
  if (id == null) return null;

  const document = await Document.findById(id);
  if (document) return document;
  return await Document.create({ _id: id, data: DEFAULT_VALUE });
}

// Socket.io connection logic
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('get-document', async (documentId) => {
    // Join a room based on the documentId
    socket.join(documentId);
    console.log(`User ${socket.id} joined room: ${documentId}`);

    // Load or create the document
    const document = await findOrCreateDocument(documentId);
    socket.emit('load-document', { data: document.data, title: document.title });

    // Broadcast incoming mutations (deltas) to others in the same room
    socket.on('send-changes', (delta) => {
      socket.to(documentId).emit('receive-changes', delta);
    });

    // Broadcast incoming title changes to others in the same room
    socket.on('send-title-changes', (title) => {
      socket.to(documentId).emit('receive-title-changes', title);
    });

    // Save the document updates
    socket.on('save-document', async (data) => {
      await Document.findByIdAndUpdate(documentId, { data });
    });

    // Save the title updates
    socket.on('save-title', async (title) => {
      await Document.findByIdAndUpdate(documentId, { title });
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

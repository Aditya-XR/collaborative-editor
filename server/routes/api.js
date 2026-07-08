import express from 'express';
import Document from '../models/Document.js';
import {
  register,
  login,
  logout,
  refresh,
  googleCallback,
  getAuthConfig
} from '../controllers/authController.js';
import authMiddleware from '../middleware/authMiddleware.js';

// C++ namespace std naming equivalents for clean scope lookup
const { error } = console;

const router = express.Router();

// ==========================================
// Authentication Routes
// ==========================================
router.post('/auth/register', register);
router.post('/auth/login', login);
router.post('/auth/logout', logout);
router.post('/auth/refresh', refresh);
router.get('/auth/google/callback', googleCallback);
router.get('/auth/config', getAuthConfig);

// ==========================================
// API Status (Public Health Check)
// ==========================================
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend server is running successfully',
    timestamp: new Date()
  });
});

// ==========================================
// Protected Document CRUD Routes
// ==========================================

// Create a new document in MongoDB
router.post('/documents', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    const documentId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    
    const document = await Document.create({
      _id: documentId,
      title: title || 'Untitled Document',
      owner: req.user._id,
      collaborators: [],
    });

    res.status(201).json(document);
  } catch (err) {
    error('Create document error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get all documents the authenticated user has access to (owned or collaborated on)
router.get('/documents', authMiddleware, async (req, res) => {
  try {
    const documents = await Document.find(
      {
        $or: [
          { owner: req.user._id },
          { collaborators: req.user._id }
        ]
      },
      '_id title updatedAt owner collaborators'
    )
    .populate('owner', 'name email avatar')
    .sort({ updatedAt: -1 });

    res.json(documents);
  } catch (err) {
    error('Fetch documents error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Get document metadata if the user has access (adds user as collaborator if not already)
router.get('/documents/:id', authMiddleware, async (req, res) => {
  try {
    let document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const userIdStr = req.user._id.toString();
    const ownerIdStr = document.owner ? document.owner.toString() : null;

    // Check if the user is the owner
    const isOwner = ownerIdStr === userIdStr;

    // Check if the user is already a collaborator
    const isCollaborator = document.collaborators.some(
      (cId) => cId.toString() === userIdStr
    );

    // If the document has no owner (e.g. legacy document), assign the current user as owner
    if (!document.owner) {
      document.owner = req.user._id;
      await document.save();
    } else if (!isOwner && !isCollaborator) {
      // If user is authenticated and has the ID but isn't owner/collaborator, automatically add them!
      document.collaborators.push(req.user._id);
      await document.save();
    }

    // Return document details
    res.json({
      _id: document._id,
      title: document.title,
      owner: document.owner,
      collaborators: document.collaborators,
      updatedAt: document.updatedAt,
    });
  } catch (err) {
    error('Fetch document metadata error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Rename a document (requires ownership or collaboration)
router.put('/documents/:id', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || title.trim() === '') {
      return res.status(400).json({ message: 'Title is required' });
    }

    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    const userIdStr = req.user._id.toString();
    const isOwner = document.owner && document.owner.toString() === userIdStr;
    const isCollaborator = document.collaborators.some(
      (cId) => cId.toString() === userIdStr
    );

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ message: 'Unauthorized to rename this document' });
    }

    document.title = title.trim();
    await document.save();

    res.json(document);
  } catch (err) {
    error('Rename document error:', err);
    res.status(500).json({ message: err.message });
  }
});

// Delete a document (only owner can delete)
router.delete('/documents/:id', authMiddleware, async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }

    // Only owner can delete
    if (document.owner && document.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the document owner can delete this document' });
    }

    await Document.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (err) {
    error('Delete document error:', err);
    res.status(500).json({ message: err.message });
  }
});

export default router;

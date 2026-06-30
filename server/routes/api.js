import express from 'express';
import Document from '../models/Document.js';

const router = express.Router();

// @desc    Get API Status (Health check)
// @route   GET /api/status
// @access  Public
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend server is running successfully',
    timestamp: new Date()
  });
});

// @desc    Get all documents (metadata only)
// @route   GET /api/documents
// @access  Public
router.get('/documents', async (req, res) => {
  try {
    const documents = await Document.find({}, '_id title updatedAt').sort({ updatedAt: -1 });
    res.json(documents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Rename a document
// @route   PUT /api/documents/:id
// @access  Public
router.put('/documents/:id', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || title.trim() === '') {
      return res.status(400).json({ message: 'Title is required' });
    }
    const document = await Document.findByIdAndUpdate(
      req.params.id,
      { title: title.trim() },
      { new: true }
    );
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }
    res.json(document);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// @desc    Delete a document
// @route   DELETE /api/documents/:id
// @access  Public
router.delete('/documents/:id', async (req, res) => {
  try {
    const document = await Document.findByIdAndDelete(req.params.id);
    if (!document) {
      return res.status(404).json({ message: 'Document not found' });
    }
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;

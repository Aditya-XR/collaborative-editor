import express from 'express';
import Document from '../models/Document.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { GoogleGenAI } = require('@google/genai');

const router = express.Router();

// GET /api/documents/search?q=...
router.get('/documents/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    console.log(`[Server AI Search] Endpoint hit. Query q: "${q || ''}" by user: ${req.user._id}`);
    
    const filter = {
      $or: [
        { owner: req.user._id },
        { collaborators: req.user._id }
      ]
    };
    
    if (q && q.trim() !== '') {
      filter.title = { $regex: q, $options: 'i' };
    }
    
    const documents = await Document.find(filter);
    console.log(`[Server AI Search] Found ${documents.length} matching documents.`);
    res.json(documents);
  } catch (error) {
    console.error('[Server AI Search] Search error:', error);
    res.status(500).json({ error: 'Failed to search documents' });
  }
});

// POST /api/ai/ask
router.post('/ai/ask', authMiddleware, async (req, res) => {
  try {
    const { prompt, currentDocText } = req.body;
    console.log(`[Server AI Ask] Prompt received: "${prompt}"`);
    console.log(`[Server AI Ask] Current doc text length: ${currentDocText ? currentDocText.length : 0}`);
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Parse @filename tags (allows quoted names like @"file name" or unquoted like @filename)
    const matches = [...prompt.matchAll(/@"(.*?)"|@([a-zA-Z0-9_\-\.]+)/g)];
    const fileNames = matches.map(m => m[1] || m[2]).filter(Boolean);
    console.log(`[Server AI Ask] Parsed referenced fileNames:`, fileNames);
    
    let extractedContext = '';
    
    if (fileNames.length > 0) {
      const documents = await Document.find({
        title: { $in: fileNames },
        $or: [
          { owner: req.user._id },
          { collaborators: req.user._id }
        ]
      });
      console.log(`[Server AI Ask] Found ${documents.length} matching documents in database.`);
      
      for (const doc of documents) {
        console.log(`[Server AI Ask] Processing document: "${doc.title}" (ID: ${doc._id})`);
        if (doc.data) {
          try {
            const ydoc = new Y.Doc();
            let updateData = doc.data;
            if (doc.data.buffer && Buffer.isBuffer(doc.data.buffer)) {
              updateData = doc.data.buffer;
            }
            if (updateData instanceof Uint8Array || Buffer.isBuffer(updateData)) {
              Y.applyUpdate(ydoc, new Uint8Array(updateData));
              const text = ydoc.getText('quill').toString();
              console.log(`[Server AI Ask] Extracted Yjs text for "${doc.title}" (length: ${text.length}): "${text.substring(0, 100)}..."`);
              extractedContext += `\n--- Document: ${doc.title} ---\n${text}\n`;
            } else {
              console.warn(`[Server AI Ask] doc.data for "${doc.title}" is not a valid Buffer/Uint8Array`);
            }
          } catch (err) {
            console.error(`[Server AI Ask] Error parsing document ${doc.title} data:`, err);
          }
        } else {
          console.log(`[Server AI Ask] Document "${doc.title}" has no data buffer (empty document).`);
        }
      }
    }

    // Initialize Gemini AI exactly as requested
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    const promptInput = `Context documents text data:\n${extractedContext}\n\nCurrent doc text:\n${currentDocText}\n\nUser request:${prompt}`;
    console.log(`[Server AI Ask] Sending input to Gemini (length: ${promptInput.length})`);
    
    const response = await ai.interactions.create({
        model: 'gemini-3.5-flash',
        input: promptInput
    });
    console.log(`[Server AI Ask] Gemini response received (output text length: ${response.output_text ? response.output_text.length : 0})`);

    res.json({ output_text: response.output_text });
  } catch (error) {
    console.error('AI ask error:', error);
    res.status(500).json({ error: error.message || 'Failed to process AI request' });
  }
});

export default router;

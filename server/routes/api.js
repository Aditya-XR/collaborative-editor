import express from 'express';

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

export default router;

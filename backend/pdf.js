// backend/routes/pdfRoutes.js

const express = require('express');
const router = express.Router();
const { generatePdf } = require('../controllers/pdfController');

// The route will be POST /api/generate-pdf
router.post('/generate-pdf', generatePdf);

module.exports = router;
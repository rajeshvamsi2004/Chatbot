// backend/pdfroutes.js

const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
// The GoogleGenerativeAI is no longer needed for this file
// const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
const PDF_PORT = 5001;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- PDF Generation Route (English Only) ---
app.post('/generate-pdf', async (req, res) => {
    // We only need summary, key_points, and query now.
    const { summary, key_points, query } = req.body;

    // Updated validation
    if (!summary || !key_points || !query) {
        return res.status(400).json({ error: 'Missing summary, key_points, or query for PDF generation.' });
    }

    console.log(`[PDF Server] English PDF request received for query "${query}"`);

    try {
        // --- NO MORE AI REWRITING ---
        // The content is used directly from the request body.

        console.log('[PDF Server] Building PDF in memory...');
        // Use the standard PDFDocument with default fonts.
        const doc = new PDFDocument({ margin: 50 });
        
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            const pdfBase64 = pdfData.toString('base64');
            const fileName = `analysis_${query.replace(/\s+/g, '_')}.pdf`;

            // This part remains the same to avoid IDM issues.
            res.status(200).json({
                pdfBase64: pdfBase64,
                fileName: fileName
            });

            console.log('[PDF Server] Sent Base64 PDF data to client in JSON response.');
        });
        
        // --- PDF Content Generation using standard Helvetica font ---
        doc.font('Helvetica-Bold').fontSize(18).text(`Analysis for: ${query}`, { align: 'center' });
        doc.moveDown(2);
        
        doc.font('Helvetica-Bold').fontSize(14).text('Summary', { underline: true });
        doc.moveDown();
        // Use 'summary' and 'key_points' directly from the request
        doc.font('Helvetica').fontSize(12).text(summary, { align: 'justify' });
        doc.moveDown(2);
        
        doc.font('Helvetica-Bold').fontSize(14).text('Key Takeaways', { underline: true });
        doc.moveDown();
        doc.font('Helvetica').fontSize(12).list(key_points, { bulletRadius: 2 });
        
        doc.end();

    } catch (error) {
        console.error('❌ [PDF Server] Error:', error);
        res.status(500).json({ error: 'Failed to generate PDF.' });
    }
});

// --- Server Startup ---
app.listen(PDF_PORT, () => console.log(`📄 PDF Server running on port ${PDF_PORT}`));
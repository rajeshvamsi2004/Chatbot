// backend/controllers/pdfController.js

const PDFDocument = require('pdfkit');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// Initialize Gemini AI. Ensure GEMINI_API_KEY is in your .env file.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const generatePdf = async (req, res) => {
    // 1. Destructure the necessary data from the request body.
    const { summary, key_points, query, targetLanguage } = req.body;

    if (!summary || !key_points || !query || !targetLanguage) {
        return res.status(400).json({ error: 'Missing required data for PDF generation.' });
    }

    console.log(`[PDF] Request received for query "${query}" in language/style: "${targetLanguage}"`);

    try {
        // 2. Create the prompt for Gemini to rewrite the content.
        console.log('[PDF] Rewriting content with Gemini...');
        const rewritePrompt = `
            You are an expert multilingual translator and writing stylist. Your task is to rewrite the following research summary into the language or style specified by the user.

            User's target style/language: "${targetLanguage}"

            Original content to rewrite:
            ---
            Summary:
            ${summary}

            Key Points:
            ${JSON.stringify(key_points, null, 2)}
            ---

            Please provide the rewritten content in a valid JSON format with the following structure. Do NOT add any extra commentary or introductory text, just the raw JSON object.
            {
              "rewritten_summary": "The summary rewritten in the requested style/language.",
              "rewritten_key_points": [
                "The first key point rewritten in the requested style/language.",
                "The second key point rewritten in the requested style/language."
              ]
            }
        `;
        
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash-latest",
            generationConfig: { response_mime_type: "application/json" },
        });

        const result = await model.generateContent(rewritePrompt);
        const rewrittenContent = JSON.parse(result.response.text());

        // 3. Create the PDF document using pdfkit.
        console.log('[PDF] Building PDF document...');
        const doc = new PDFDocument({ margin: 50, font: 'Helvetica' });
        
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            // 4. Send the finished PDF back to the client.
            res.writeHead(200, {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment;filename=analysis_${query.replace(/\s+/g, '_')}.pdf`,
            }).end(pdfData);
            console.log('[PDF] Sent PDF to client.');
        });
        
        // Add content to the PDF
        doc.fontSize(18).font('Helvetica-Bold').text(`Analysis for: ${query}`, { align: 'center' });
        doc.moveDown(2);

        doc.fontSize(14).font('Helvetica-Bold').text('Summary', { underline: true });
        doc.moveDown();
        doc.fontSize(12).font('Helvetica').text(rewrittenContent.rewritten_summary, { align: 'justify' });
        doc.moveDown(2);

        doc.fontSize(14).font('Helvetica-Bold').text('Key Takeaways', { underline: true });
        doc.moveDown();
        doc.fontSize(12).font('Helvetica').list(rewrittenContent.rewritten_key_points, { bulletRadius: 2 });
        
        // Finalize the PDF and trigger the 'end' event to send the response
        doc.end();

    } catch (error) {
        console.error('❌ PDF Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate PDF.' });
    }
};

// Export the function to be used in your routes file.
module.exports = { generatePdf };
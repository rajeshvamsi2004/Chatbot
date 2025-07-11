const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
require('dotenv').config();

const multer = require('multer');
const PDFParser = require("pdf2json"); 

const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ▼▼▼ 1. SELENIUM DEPENDENCIES ADDED ▼▼▼
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
// Make sure you have run: npm install selenium-webdriver chromedriver

const History = require('./models/History.js');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Job Search Function (UNCHANGED) ---
async function searchJobs(jobQuery, location = 'USA', page = '1') {
    const options = {
        method: 'GET',
        url: 'https://jsearch.p.rapidapi.com/search',
        params: {
            query: `${jobQuery} in ${location}`,
            page: page,
            num_pages: '1'
        },
        headers: {
            'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        }
    };

    try {
        console.log(`[JOB SEARCH] Querying JSearch API for: "${jobQuery} in ${location}"`);
        const response = await axios.request(options);
        return response.data.data;
    } catch (error) {
        console.error("❌ JSearch API Error:", error.message);
        return null;
    }
}

// --- New Job Search Endpoint (UNCHANGED) ---
app.get('/jobs', async (req, res) => {
    const { query, location } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Job "query" is required.' });
    }

    const jobs = await searchJobs(query, location);

    if (jobs) {
        res.status(200).json(jobs);
    } else {
        res.status(500).json({ error: 'Failed to fetch job listings.' });
    }
});


// --- Sanitize query (UNCHANGED) ---
function sanitizeQuery(query) {
    const instructionalWords = ['explain about', 'explain', 'what is', 'what are', 'who is', 'who are', 'tell me about', 'give me information on', 'define', 'definition of'];
    let sanitized = query.toLowerCase().trim();
    for (const word of instructionalWords) {
        if (sanitized.startsWith(word + ' ')) {
            sanitized = sanitized.substring(word.length).trim();
            break;
        }
    }
    return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
}


const { URL } = require('url');

// --- DuckDuckGo Search Functions (UNCHANGED) ---
function decodeDuckDuckGoUrl(href) {
    try {
        const urlObj = new URL('https://duckduckgo.com' + href);
        const realUrl = decodeURIComponent(urlObj.searchParams.get('uddg'));
        return realUrl;
    } catch (e) {
        return null;
    }
}

async function duckDuckGoSearch(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const { data } = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const $ = cheerio.load(data);
        const results = [];

        $('a.result__a').each((i, el) => {
            const title = $(el).text();
            const rawLink = $(el).attr('href');
            const realLink = decodeDuckDuckGoUrl(rawLink);
            const snippet = $(el).closest('.result').find('.result__snippet').text().trim();
            if (realLink) {
                results.push({ title, link: realLink, snippet });
            }
        });

        return results;
    } catch (error) {
        console.error('❌ DuckDuckGo scrape failed:', error.message);
        return [];
    }
}


// ▼▼▼ 2. NEW SELENIUM CRAWLER FUNCTION ▼▼▼
// This function replaces the old axios-based crawlAndExtract function.
// It uses a headless Chrome browser to load pages, execute JavaScript,
// and then extracts the main article content.
async function crawlAndExtractWithSelenium(url, title) {
    console.log(`\t[SELENIUM CRAWL] Attempting to crawl: ${url}`);
    let driver;

    try {
        const options = new chrome.Options();
        options.addArguments('--headless'); // Run in the background
        options.addArguments('--disable-gpu');
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--log-level=3'); // Suppress console logs from chrome
        options.addArguments("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");

        driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();

        // Navigate to the page with a timeout
        await driver.get(url);
        
        // Wait for the body of the page to be loaded, max 15 seconds
        await driver.wait(until.elementLocated(By.tagName('body')), 15000);

        // Get the full page source after JavaScript has executed
        const pageSource = await driver.getPageSource();

        // Use Readability.js to parse the article content from the HTML
        const dom = new JSDOM(pageSource, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article && article.textContent) {
            console.log(`\t[SELENIUM CRAWL] ✅ SUCCESS for: ${url}`);
            return {
                title,
                textContent: article.textContent.trim().substring(0, 8000)
            };
        } else {
            console.log(`\t[SELENIUM CRAWL] ⚠️ No readable content for: ${url}`);
            return null;
        }

    } catch (err) {
        console.log(`\t[SELENIUM CRAWL] ❌ ERROR: ${url} | ${err.message}`);
        return null;
    } finally {
        if (driver) {
            await driver.quit(); // Always close the browser session
        }
    }
}

// NOTE: The old `crawlAndExtract` function has been removed as it's now replaced by the Selenium version.

// --- Main API Endpoint (MODIFIED TO USE SELENIUM) ---
app.post('/api', async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }

    const searchQuery = sanitizeQuery(query);
    console.log(`Original: "${query}" | Search: "${searchQuery}"`);

    try {
        console.log(`[1/5] Scraping DuckDuckGo for: ${searchQuery}`);
        const searchResults = await duckDuckGoSearch(searchQuery);

        if (searchResults.length === 0) {
            return res.json({
                summary: "No relevant sources were found online for your query.",
                key_points: [],
                sources: [],
                all_search_results: []
            });
        }

        const uniqueLinks = new Map();
        searchResults.forEach(result => {
            if (result.link && !uniqueLinks.has(result.link)) {
                uniqueLinks.set(result.link, result);
            }
        });

        const uniqueSources = Array.from(uniqueLinks.values());
        const linksToAnalyze = uniqueSources.slice(0, 5); // Using 5 links to balance performance and depth

        console.log(`[2/5] Crawling top ${linksToAnalyze.length} sources with Selenium...`);
        
        // ▼▼▼ 3. CALLING THE NEW SELENIUM FUNCTION ▼▼▼
        const crawlPromises = linksToAnalyze.map(item => crawlAndExtractWithSelenium(item.link, item.title));
        const crawledSettled = await Promise.allSettled(crawlPromises);

        const extracted = [];
        crawledSettled.forEach((result, index) => {
            const originalSource = linksToAnalyze[index];
            if (result.status === 'fulfilled' && result.value && result.value.textContent) {
                extracted.push(result.value);
            } else {
                console.log(`\t[CRAWL] ⚠️ Fallback to snippet for: ${originalSource.link}`);
                if (originalSource.snippet) { 
                    extracted.push({
                        title: originalSource.title,
                        textContent: originalSource.snippet
                    });
                }
            }
        });

        if (extracted.length === 0) {
            return res.status(500).json({ error: "Could not read content from any of the top sources. Please try again." });
        }

        console.log(`[3/5] Extracted content from ${extracted.length} sources.`);

        const combinedText = extracted.map((c, i) =>
            `--- Source ${i + 1}: ${c.title} ---\n${c.textContent}\n\n`
        ).join('');
        
        const prompt = `
You are an expert research analyst. Your task is to provide a comprehensive and detailed answer to the user's query based *only* on the provided text from the following web sources.

User Query: "${query}"

Sources:
${combinedText}

Please synthesize the information from the sources into a valid JSON object with the following structure:
{
  "summary": "A detailed, multi-paragraph summary that thoroughly answers the user's query. Be comprehensive and draw connections between the sources.",
  "key_points": ["A list of the most crucial points or takeaways, each as a string.", "Ensure these are distinct and important.", "Aim for 3-5 key points."],
  "sources_used": [An array of numbers corresponding to the source(s) you used for the information, for example, [1, 3, 4]],
  "follow_up_questions": ["An array of 3-4 interesting and relevant follow-up questions a user might ask after reading the summary. Each question should be a concise string."]
}

Do not include any information not present in the provided sources. Your response must be only the JSON object, without any markdown or explanatory text.
        `;

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash-latest",
            generationConfig: {
                response_mime_type: "application/json",
            },
        });
        
        console.log('[4/5] Generating analysis with Gemini...');
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            console.error("❌ Failed to parse Gemini response:", text);
            return res.status(500).json({ error: "The AI returned an invalid response. Please try rephrasing your query." });
        }

        const sourcesUsed = parsed.sources_used
            ? parsed.sources_used
                .map(num => extracted[num - 1] ? linksToAnalyze[num - 1] : null)
                .filter(Boolean)
            : [];

        console.log('[5/5] Successfully generated response.');
        res.json({
            summary: parsed.summary,
            key_points: parsed.key_points,
            sources: sourcesUsed,
            follow_up_questions: parsed.follow_up_questions || [],
            all_search_results: uniqueSources
        });

    } catch (err) {
        console.error("❌ Pipeline Error:", err.message);
        res.status(500).json({ error: "An unexpected error occurred during the analysis process." });
    }
});


// --- File Analysis Endpoint (UNCHANGED) ---
app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }
  
    try {
        console.log(`[FILE] Received file: ${req.file.originalname} | Size: ${req.file.size} bytes`);
        let extractedText = '';
        const file = req.file;
  
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
            console.log('[FILE] Parsing PDF with pdf2json...');
            
            const parsePdf = new Promise((resolve, reject) => {
                const pdfParser = new PDFParser(this, 1);

                pdfParser.on("pdfParser_dataError", errData => {
                    console.error("pdf2json Error:", errData.parserError);
                    reject(new Error("Failed to parse PDF. It might be corrupted or in an unsupported format."));
                });

                pdfParser.on("pdfParser_dataReady", () => {
                    const textContent = pdfParser.getRawTextContent();
                    console.log('[FILE] pdf2json parsing complete.');
                    resolve(textContent);
                });

                pdfParser.parseBuffer(file.buffer);
            });
            
            extractedText = await parsePdf;

        } else if (file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
            console.log('[FILE] Reading text file...');
            extractedText = file.buffer.toString('utf-8');
        } else {
            return res.status(400).json({ error: "Unsupported file type. Please upload a .txt or .pdf file." });
        }
  
        if (!extractedText || !extractedText.trim()) {
            return res.status(400).json({ error: "Could not extract any text from the file. It might be empty or an image-based PDF." });
        }

        console.log(`[FILE] Extracted ${extractedText.length} characters. Generating summary...`);
      
        const prompt = `
        Analyze the following document and provide a concise summary and a list of key takeaways.
        
        Document Content:
        ---
        ${extractedText.substring(0, 15000)} 
        ---
  
        Format your response strictly as a JSON object with two keys: "summary" and "key_points" (which must be an array of strings).
        Do not include any other text or markdown formatting outside of the JSON object.
        Example:
        {
            "summary": "A brief overview of the document's main points.",
            "key_points": [
                "First important takeaway.",
                "Second important takeaway."
            ]
        }
      `;
  
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash-latest",
        generationConfig: {
            response_mime_type: "application/json",
        },
    });

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      let analysisData = JSON.parse(responseText);
      
      const finalResponse = {
          ...analysisData,
          sources: [],
          all_search_results: [],
          follow_up_questions: []
      };
  
      console.log('[FILE] Successfully generated file analysis.');
      res.json(finalResponse);
  
    } catch (error) {
      console.error("❌ Error during file analysis:", error);
      const errorMessage = error.message || "An internal server error occurred during file analysis.";
      res.status(500).json({ error: errorMessage });
    }
  });


// --- History Routes (UNCHANGED) ---
app.post('/api/history', async (req, res) => { try { const { query } = req.body; if (!query) return res.status(400).json({ msg: 'Query is required.' }); const saved = await new History({ query }).save(); res.status(201).json(saved); } catch (error) { res.status(500).json({ msg: 'Failed to save history.' }); } });
app.get('/api/history', async (req, res) => { try { const all = await History.find().sort({ createdAt: -1 }); res.status(200).json(all); } catch (error) { res.status(500).json({ msg: 'Error fetching history.' }); } });
app.delete('/api/history/:id', async (req, res) => { try { const deleted = await History.findByIdAndDelete(req.params.id); if (!deleted) return res.status(404).json({ message: 'Not found' }); res.status(200).json({ message: 'Deleted successfully' }); } catch (error) { res.status(500).json({ message: 'Error deleting item' }); } });
app.put('/api/history/:id', async (req, res) => { try { const { query } = req.body; const updated = await History.findByIdAndUpdate(req.params.id, { query }, { new: true }); if (!updated) return res.status(404).json({ message: 'Item not found' }); res.status(200).json(updated); } catch (error) { res.status(500).json({ message: 'Error updating item' }); } });

// --- MongoDB Connection & Server Start (UNCHANGED) ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
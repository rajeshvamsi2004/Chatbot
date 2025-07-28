// --- 1. IMPORTS & SETUP ---
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const multer = require('multer');
// const PDFParser = require("pdf2json"); // <-- REMOVED: Unused dependency
const storage = multer.memoryStorage();
const upload = multer({ storage: multer.memoryStorage() });
const Tesseract = require('tesseract.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

// Local imports
const History = require('./models/History.js');
// const { findSimilarQuery, cacheQueryResult } = require('./vectorCache.js'); // <-- REMOVED

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- 2. OPTIMIZED SCRAPING FUNCTIONS ---

// Global driver pool for reusing browser instances
let driverPool = [];
const MAX_DRIVERS = 3;
let driverPoolInitialized = false;

// Initialize driver pool
async function initializeDriverPool() {
    console.log('🚀 Initializing driver pool...');
    for (let i = 0; i < MAX_DRIVERS; i++) {
        const options = new chrome.Options()
            .addArguments(
                '--headless',
                '--disable-gpu',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-images', // Skip image loading
                '--disable-javascript', // Skip JS if not needed
                '--disable-css', // Skip CSS if not needed
                '--disable-plugins',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--window-size=1920,1080',
                '--log-level=3'
            );
        
        const driver = await new Builder()
            .forBrowser('chrome')
            .setChromeOptions(options)
            .build();
            
        await driver.manage().setTimeouts({
            pageLoad: 15000,
            script: 10000,
            implicit: 5000
        });
        
        driverPool.push(driver);
    }
}

// Get available driver from pool
async function getDriver() {
    if (driverPool.length === 0) {
        await initializeDriverPool();
    }
    return driverPool.pop();
}

// Return driver to pool
function returnDriver(driver) {
    driverPool.push(driver);
}

// Cleanup driver pool
async function cleanupDriverPool() {
    console.log('🧹 Cleaning up driver pool...');
    for (const driver of driverPool) {
        try {
            await driver.quit();
        } catch (err) {
            console.error('Error closing driver:', err);
        }
    }
    driverPool = [];
}

// OPTION 1: Hybrid approach - try requests first, fallback to Selenium
async function crawlWithHybridApproach(links) {
    if (!links || links.length === 0) return [];
    
    const results = [];
    const failedLinks = [];
    
    // First pass: Try with requests + cheerio (much faster)
    console.log('📡 Phase 1: Trying fast extraction with requests...');
    const requestPromises = links.map(async (linkInfo) => {
        const { link, title } = linkInfo;
        try {
            const response = await axios.get(link, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive',
                }
            });
            
            const dom = new JSDOM(response.data, { url: link });
            const article = new Readability(dom.window.document).parse();
            
            if (article && article.textContent && article.textContent.trim().length > 200) {
                const cleanText = article.textContent.trim().replace(/\s{2,}/g, ' ');
                console.log(`✅ Fast extraction successful for: ${link}`);
                return { status: 'success', title, link, textContent: cleanText.substring(0, 8000) };
            } else {
                failedLinks.push(linkInfo);
                return { status: 'fail', link };
            }
        } catch (error) {
            failedLinks.push(linkInfo);
            return { status: 'fail', link };
        }
    });
    
    const requestResults = await Promise.all(requestPromises);
    results.push(...requestResults.filter(r => r.status === 'success'));
    
    // Second pass: Use Selenium for failed links
    if (failedLinks.length > 0 && results.length < 2) {
        console.log(`🔄 Phase 2: Using Selenium for ${failedLinks.length} failed links...`);
        const seleniumResults = await crawlWithSeleniumPool(failedLinks);
        results.push(...seleniumResults);
    }
    
    return results;
}

// OPTION 2: Optimized Selenium with driver pool
async function crawlWithSeleniumPool(links) {
    if (!links || links.length === 0) return [];
    
    const crawlSingleLink = async (linkInfo) => {
        const { link, title } = linkInfo;
        const driver = await getDriver();
        
        try {
            console.log(`🔍 Selenium crawling: ${link}`);
            await driver.get(link);
            
            // Wait for basic content to load
            await driver.wait(until.elementLocated(By.tagName('body')), 10000);
            
            const pageSource = await driver.getPageSource();
            const dom = new JSDOM(pageSource, { url: link });
            const article = new Readability(dom.window.document).parse();
            
            if (article && article.textContent) {
                const cleanText = article.textContent.trim().replace(/\s{2,}/g, ' ');
                console.log(`✅ Selenium extraction successful for: ${link}`);
                return { status: 'success', title, link, textContent: cleanText.substring(0, 8000) };
            } else {
                return { status: 'fail', link };
            }
        } catch (err) {
            console.log(`❌ Selenium failed for ${link}: ${err.message.split('\n')[0]}`);
            return { status: 'fail', link };
        } finally {
            returnDriver(driver);
        }
    };
    
    // Limit concurrent Selenium operations
    const batchSize = Math.min(links.length, MAX_DRIVERS);
    const results = [];
    
    for (let i = 0; i < links.length; i += batchSize) {
        const batch = links.slice(i, i + batchSize);
        const batchPromises = batch.map(linkInfo => crawlSingleLink(linkInfo));
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(r => r.status === 'success'));
    }
    
    return results;
}

// OPTION 3: Pure requests approach (fastest)
async function crawlWithRequestsOnly(links) {
    if (!links || links.length === 0) return [];
    
    console.log('⚡ Using pure requests approach for maximum speed...');
    
    const crawlSingleLink = async (linkInfo) => {
        const { link, title } = linkInfo;
        
        try {
            const response = await axios.get(link, {
                timeout: 10000,
                maxRedirects: 3,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                }
            });
            
            // Try multiple extraction methods
            const dom = new JSDOM(response.data, { url: link });
            let article = new Readability(dom.window.document).parse();
            
            if (!article || !article.textContent || article.textContent.trim().length < 200) {
                // Fallback: manual content extraction
                const $ = cheerio.load(response.data);
                
                // Remove unwanted elements
                $('script, style, nav, header, footer, aside, .advertisement, .ads, .social-share').remove();
                
                // Try common content selectors
                const contentSelectors = [
                    'article', '[role="main"]', '.content', '.post-content', 
                    '.entry-content', '.article-content', 'main', '.container p'
                ];
                
                let extractedText = '';
                for (const selector of contentSelectors) {
                    const content = $(selector).text().trim();
                    if (content.length > extractedText.length) {
                        extractedText = content;
                    }
                }
                
                if (extractedText.length > 200) {
                    article = { textContent: extractedText };
                }
            }
            
            if (article && article.textContent && article.textContent.trim().length > 200) {
                const cleanText = article.textContent.trim().replace(/\s{2,}/g, ' ');
                console.log(`✅ Requests extraction successful for: ${link}`);
                return { status: 'success', title, link, textContent: cleanText.substring(0, 8000) };
            } else {
                console.log(`⚠️ Insufficient content for: ${link}`);
                return { status: 'fail', link };
            }
            
        } catch (error) {
            console.log(`❌ Requests failed for ${link}: ${error.message}`);
            return { status: 'fail', link };
        }
    };
    
    const crawlPromises = links.map(linkInfo => crawlSingleLink(linkInfo));
    const results = await Promise.all(crawlPromises);
    
    return results.filter(r => r.status === 'success');
}

// Enhanced DuckDuckGo search with better filtering
async function enhancedDuckDuckGoSearch(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };
        
        const { data } = await axios.get(searchUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(data);
        const results = [];
        const { URL } = require('url');
        
        $('a.result__a').each((i, el) => {
            const title = $(el).text().trim();
            const rawLink = $(el).attr('href');
            
            try {
                const urlObj = new URL('https://duckduckgo.com' + rawLink);
                const realUrl = decodeURIComponent(urlObj.searchParams.get('uddg'));
                const snippet = $(el).closest('.result').find('.result__snippet').text().trim();
                
                if (realUrl && title && !isLowQualityDomain(realUrl)) {
                    results.push({ title, link: realUrl, snippet });
                }
            } catch (e) {
                // Ignore invalid links
            }
        });
        
        return results;
    } catch (error) {
        console.error('❌ Enhanced DuckDuckGo scrape failed:', error.message);
        return [];
    }
}

// Filter out low-quality domains
function isLowQualityDomain(url) {
    const lowQualityDomains = [
        'pinterest.com', 'instagram.com', 'twitter.com', 'facebook.com',
        'youtube.com', 'tiktok.com', 'reddit.com', 'quora.com'
    ];
    
    return lowQualityDomains.some(domain => url.includes(domain));
}

// --- 3. HELPER & UTILITY FUNCTIONS ---
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

// --- 4. OPTIMIZED API ROUTES ---
app.post('/api', async (req, res) => {
    const { query } = req.body;
    if (!query) { 
        return res.status(400).json({ error: 'Query is required.' }); 
    }

    const startTime = Date.now();
    console.log(`\n--- [OPTIMIZED PIPELINE START] ---`);
    console.log(`[PIPELINE] Received query: "${query}"`);

    try {
        // // Check cache first <-- REMOVED
        // const cachedResult = await findSimilarQuery(query);
        // if (cachedResult) {
        //     console.log(`[PIPELINE] ✅ Cache hit! Returning cached result.`);
        //     return res.json({ ...cachedResult, fromCache: true });
        // }

        console.log(`[PIPELINE] Step 1: Searching DuckDuckGo...`); // Step number updated
        const searchQuery = sanitizeQuery(query);
        
        // Use enhanced search
        const searchResults = await enhancedDuckDuckGoSearch(searchQuery);

        if (!searchResults || searchResults.length === 0) {
            console.log(`[PIPELINE] ⚠️ No sources found on DuckDuckGo for query: "${searchQuery}"`);
            return res.json({ 
                summary: "I couldn't find any relevant sources online to answer your question. Please try a different query.", 
                key_points: [], 
                sources: [], 
                all_search_results: [] 
            });
        }
        
        // Get unique links and select top results
        const uniqueLinks = Array.from(new Map(searchResults.map(item => [item.link, item])).values());
        const linksToAnalyze = uniqueLinks.slice(0, 5); // Increased to 5 for better content
        console.log(`[PIPELINE] Found ${searchResults.length} results. Crawling top ${linksToAnalyze.length}...`);
        
        // Initialize driver pool if needed (lazy initialization)
        if (!driverPoolInitialized) {
            await initializeDriverPool();
            driverPoolInitialized = true;
        }
        
        // Choose crawling strategy based on your needs:
        
        // OPTION 1: Fastest - Pure requests (recommended for speed)
        const extracted = await crawlWithRequestsOnly(linksToAnalyze);
        
        // OPTION 2: Balanced - Hybrid approach (uncomment to use)
        // const extracted = await crawlWithHybridApproach(linksToAnalyze);
        
        // OPTION 3: Most reliable but slower - Selenium only
        // const extracted = await crawlWithSeleniumPool(linksToAnalyze);

        if (extracted.length === 0) {
            console.log(`[PIPELINE] ⚠️ No content could be extracted from any source.`);
            return res.status(500).json({ 
                error: "I found sources, but was unable to read their content. This can happen with complex websites or network issues." 
            });
        }

        console.log(`[PIPELINE] Step 2: Successfully extracted content from ${extracted.length} sources. Generating AI analysis...`); // Step number updated
        
        // Create combined text for AI analysis
        const combinedText = extracted.map((c, i) => 
            `--- Source ${i + 1}: ${c.title} ---\n${c.textContent}\n\n`
        ).join('');
        
        // Enhanced prompt with better instructions
        const prompt = `You are an expert research analyst. Your task is to synthesize information to answer the user's query based ONLY on the provided web sources.

USER'S QUERY: "${query}"

Analyze the following sources and generate a response in a single, valid JSON object format. The JSON object MUST have this exact structure:

{
    "summary": "A comprehensive summary that directly answers the user's query. Make it informative and well-structured.",
    "key_points": ["An array of 4-6 crucial bullet points that highlight the most important information"],
    "sources_used": [1, 2, 3],
    "follow_up_questions": ["An array of 3 insightful follow-up questions related to the topic"]
}

IMPORTANT RULES:
- You MUST include all keys in the JSON response
- If you cannot generate content for a key, return an empty array [] for arrays or empty string "" for strings
- Your entire response must be ONLY the JSON object - no additional text
- Base your answer ONLY on the provided sources
- Make the summary comprehensive but concise
- Ensure key_points are actionable and informative
- sources_used should reference the source numbers (1-based indexing)

--- SOURCES ---
${combinedText}
--- END SOURCES ---`;

        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-latest", 
            generationConfig: { 
                response_mime_type: "application/json",
                temperature: 0.3 // Lower temperature for more consistent JSON
            } 
        });
        
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            console.error("❌ AI returned invalid JSON. Raw response:", text.substring(0, 500) + "...");
            return res.status(500).json({ 
                error: "The AI analyst returned an invalidly formatted response. This may be a temporary issue." 
            });
        }
        
        // Map sources used to actual source objects
        const sourcesUsed = parsed.sources_used ? 
            parsed.sources_used.map(num => extracted[num - 1] || null).filter(Boolean) : [];
        
        const finalResponse = {
            summary: parsed.summary || "The AI did not provide a summary.",
            key_points: parsed.key_points || [],
            sources: sourcesUsed.map(s => ({ title: s.title, link: s.link })),
            follow_up_questions: parsed.follow_up_questions || [],
            all_search_results: uniqueLinks
        };

        const endTime = Date.now();
        const executionTime = (endTime - startTime) / 1000;
        console.log(`[PIPELINE] ✅ Optimized pipeline finished in ${executionTime}s (${extracted.length} sources processed).`);
        
        res.json(finalResponse);

        // Background operations (don't await these)
        setImmediate(async () => {
            try {
                const newHistory = new History({ query });
                await newHistory.save();
                // await cacheQueryResult(query, finalResponse); // <-- REMOVED
            } catch (dbError) {
                console.error("Error during background DB ops:", dbError);
            }
        });

    } catch (err) {
        console.error("❌ [PIPELINE] A critical error occurred:", err);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: "An unexpected internal error occurred." 
            });
        }
    }
});

// Test route to verify optimization
app.get('/api/test', async (req, res) => {
    try {
        const testResults = await enhancedDuckDuckGoSearch('JavaScript tutorials');
        res.json({ 
            message: 'Optimization working!', 
            results: testResults.length,
            sample: testResults[0] || null
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// --- 5. ALL OTHER ROUTES (UNCHANGED) ---
app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
    console.log('\n[FILE ANALYSIS] Request received.');
    if (!req.file) {
        console.log('[FILE ANALYSIS] ❌ Error: No file was uploaded.');
        return res.status(400).json({ error: "No file was uploaded." });
    }

    try {
        const file = req.file;
        console.log(`[FILE ANALYSIS] Received: ${file.originalname} (${file.mimetype})`);

        let extractedText = '';

        if (file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
            extractedText = file.buffer.toString('utf-8');
        }
        else if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
            console.log('[FILE ANALYSIS] 📄 Attempting text extraction using pdf-parse...');
            const data = await pdfParse(file.buffer);
            extractedText = data.text;

            if (!extractedText || extractedText.trim().length < 10) {
                console.log('[FILE ANALYSIS] ⚠️ Text-based extraction failed. Using OCR...');
                const tempPath = path.join(os.tmpdir(), `${Date.now()}-${file.originalname}`);
                fs.writeFileSync(tempPath, file.buffer);
                const converter = fromPath(tempPath, { density: 150, saveFilename: 'ocr_temp', savePath: os.tmpdir(), format: 'png', width: 1200 });
                const imageResult = await converter(1);
                const ocrResult = await Tesseract.recognize(imageResult.path, 'eng');
                extractedText = ocrResult.data.text;
                fs.unlinkSync(tempPath);
                fs.unlinkSync(imageResult.path);
            }
        }
        else {
            return res.status(400).json({ error: "Unsupported file type. Please upload a .txt or .pdf file." });
        }

        if (!extractedText || !extractedText.trim()) {
            return res.status(400).json({ error: "Could not extract any text from the file. It might be empty or image-based and failed OCR." });
        }

        console.log(`[FILE ANALYSIS] ✅ Extracted ${extractedText.length} characters.`);

        const prompt = `Analyze the following document and provide key points:\n\n${extractedText}`;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest", generationConfig: { response_mime_type: "application/json" } });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const analysisData = JSON.parse(responseText);

        res.json({
            ...analysisData,
            sources: [],
            all_search_results: [],
            follow_up_questions: []
        });

    } catch (error) {
        console.error("❌ Error during file analysis:", error);
        res.status(500).json({ error: error.message || "An internal server error occurred during file analysis." });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const history = await History.find({}).sort({ createdAt: -1 });
        res.status(200).json(history);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

app.post('/api/history', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query is required' });
        const newHistory = new History({ query });
        await newHistory.save();
        res.status(201).json(newHistory);
    } catch (error) {
        res.status(500).json({ error: 'Failed to save history' });
    }
});

app.delete('/api/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await History.findByIdAndDelete(id);
        res.status(200).json({ message: 'History item deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete history item' });
    }
});

app.put('/api/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'New query text is required' });
        await History.findByIdAndUpdate(id, { query });
        res.status(200).json({ message: 'History item updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update history item' });
    }
});

const coreApiKey = process.env.CORE_API_KEY;
if (!coreApiKey) {
  console.error('Error: CORE_API_KEY is not defined in the .env file. Please add it and restart the server.');
  process.exit(1);
}

async function searchOpenAlex(query) {
  const userEmail = 'r87921749@gmail.com';
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&mailto=${userEmail}`;
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error('Error fetching from OpenAlex:', error.message);
    throw new Error('Failed to fetch data from OpenAlex.');
  }
}

async function searchCore(query) {
  const url = `https://api.core.ac.uk/v3/search/works`;
  try {
    const response = await axios.post(url, { q: query }, {
      headers: { 'Authorization': `Bearer ${coreApiKey}` }
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching from CORE:', error.response ? error.response.data : error.message);
    throw new Error('Failed to fetch data from CORE.');
  }
}

app.get('/', (req, res) => {
  console.log("Root route was hit!");
  res.send('Welcome to the Scholarly Search API!');
});

app.get('/search', async (req, res) => {
  console.log("Search route was hit!");
  const { query } = req.query;
  if (!query) {
    return res.status(400).json({ error: 'A search query is required.' });
  }
  try {
    const [openAlexResults, coreResults] = await Promise.all([
      searchOpenAlex(query),
      searchCore(query)
    ]);
    res.json({
      message: 'Search successful',
      data: {
        openAlex: openAlexResults.results.map(work => ({ title: work.title, doi: work.doi })),
        core: coreResults.results.map(work => ({ title: work.title, year: work.yearPublished }))
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred while searching.' });
  }
});

// --- 6. DATABASE & SERVER INITIALIZATION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Add graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT. Gracefully shutting down...');
    await cleanupDriverPool();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM. Gracefully shutting down...');
    await cleanupDriverPool();
    process.exit(0);
});
    
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
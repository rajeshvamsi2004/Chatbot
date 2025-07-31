const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

// PDF parsing
const pdfParse = require('pdf-parse');

const { URL } = require('url');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

// Local imports
const History = require('./models/History.js');

const app = express();
const PORT = process.env.PORT || 5000;

// Enhanced CORS configuration for production
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://your-frontend-domain.com'] // Replace with actual frontend URL
        : ['http://localhost:3000', 'http://localhost:5173'],
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- ENHANCED RATE LIMITING AND ERROR HANDLING ---
class RateLimiter {
    constructor(limit = 15, window = 60000) {
        this.limit = limit;
        this.window = window;
        this.requests = [];
    }

    checkLimit() {
        const now = Date.now();
        this.requests = this.requests.filter(time => now - time < this.window);
        
        if (this.requests.length >= this.limit) {
            const oldestRequest = Math.min(...this.requests);
            const waitTime = this.window - (now - oldestRequest);
            throw new Error(`Rate limit exceeded. Try again in ${Math.ceil(waitTime / 1000)} seconds.`);
        }
        
        this.requests.push(now);
    }
}

const rateLimiter = new RateLimiter(15, 60000); // 15 requests per minute

// Circuit breaker for Gemini API
class CircuitBreaker {
    constructor(threshold = 3, timeout = 30000) {
        this.failureCount = 0;
        this.threshold = threshold;
        this.timeout = timeout;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.nextAttempt = Date.now();
    }

    async call(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error('Service temporarily unavailable. Please try again later.');
            }
            this.state = 'HALF_OPEN';
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }

    onFailure() {
        this.failureCount++;
        if (this.failureCount >= this.threshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
        }
    }
}

const geminiCircuitBreaker = new CircuitBreaker(3, 30000);

// --- ENHANCED GEMINI API CALLS WITH FALLBACK ---
async function makeGeminiRequest(prompt, isFileAnalysis = false, retries = 3) {
    const models = [
        { name: "gemini-1.5-flash-8b", maxTokens: 2048, temperature: 0.3 },
        { name: "gemini-1.5-flash", maxTokens: 2048, temperature: 0.3 },
        { name: "gemini-1.5-pro", maxTokens: 2048, temperature: 0.4 }
    ];

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const modelConfig = models[modelIndex];
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await geminiCircuitBreaker.call(async () => {
                    rateLimiter.checkLimit();
                    
                    const maxPromptLength = isFileAnalysis ? 20000 : 25000;
                    const truncatedPrompt = prompt.length > maxPromptLength 
                        ? prompt.substring(0, maxPromptLength) + "\n\n[Content truncated due to length limits]"
                        : prompt;
                    
                    console.log(`[GEMINI] Trying ${modelConfig.name} (attempt ${attempt}/${retries})`);
                    
                    const model = genAI.getGenerativeModel({ 
                        model: modelConfig.name,
                        generationConfig: { 
                            response_mime_type: "application/json",
                            temperature: modelConfig.temperature,
                            maxOutputTokens: modelConfig.maxTokens
                        } 
                    });
                    
                    const result = await model.generateContent(truncatedPrompt);
                    const response = result.response.text();
                    
                    console.log(`[GEMINI] ✅ Success with ${modelConfig.name}`);
                    return response;
                });
                
            } catch (error) {
                console.error(`[GEMINI] ${modelConfig.name} attempt ${attempt} failed:`, error.message);
                
                // If it's a rate limit error, don't try other models
                if (error.message.includes('Rate limit')) {
                    throw error;
                }
                
                // If it's the last attempt with this model, try next model
                if (attempt === retries) {
                    console.log(`[GEMINI] Moving to next model after ${retries} failed attempts`);
                    break;
                }
                
                // Exponential backoff for retries
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw new Error('All Gemini models are currently unavailable');
}

// --- OPTIMIZED SCRAPING FUNCTIONS ---
let driverPool = [];
const MAX_DRIVERS = 3;
let driverPoolInitialized = false;

async function initializeDriverPool() {
    console.log('🚀 Initializing driver pool...');
    
    for (let i = 0; i < MAX_DRIVERS; i++) {
        try {
            const options = new chrome.Options()
                .addArguments(
                    '--headless',
                    '--disable-gpu',
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-extensions',
                    '--disable-images',
                    '--disable-javascript',
                    '--disable-css',
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
        } catch (error) {
            console.error(`Failed to initialize driver ${i + 1}:`, error.message);
        }
    }
    
    driverPoolInitialized = true;
    console.log(`✅ Driver pool initialized with ${driverPool.length} drivers`);
}

async function getDriver() {
    if (!driverPoolInitialized) {
        await initializeDriverPool();
    }
    return driverPool.pop();
}

function returnDriver(driver) {
    if (driver && driverPool.length < MAX_DRIVERS) {
        driverPool.push(driver);
    } else if (driver) {
        driver.quit().catch(err => console.error("Error quitting excess driver:", err));
    }
}

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
    driverPoolInitialized = false;
}

async function crawlWithRequestsOnly(links) {
    if (!links || links.length === 0) return [];
    
    console.log('⚡ Using optimized requests approach...');
    
    const crawlSingleLink = async (linkInfo) => {
        const { link, title } = linkInfo;
        
        try {
            const response = await axios.get(link, {
                timeout: 12000,
                maxRedirects: 3,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Connection': 'keep-alive',
                }
            });
            
            const dom = new JSDOM(response.data, { url: link });
            let article = new Readability(dom.window.document).parse();
            
            if (!article || !article.textContent || article.textContent.trim().length < 200) {
                const $ = cheerio.load(response.data);
                $('script, style, nav, header, footer, aside, .advertisement, .ads, .social-share').remove();
                
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
                console.log(`✅ Content extracted from: ${link}`);
                return { status: 'success', title, link, textContent: cleanText.substring(0, 8000) };
            } else {
                console.log(`⚠️ Insufficient content for: ${link}`);
                return { status: 'fail', link };
            }
            
        } catch (error) {
            console.log(`❌ Failed to crawl ${link}: ${error.message}`);
            return { status: 'fail', link };
        }
    };
    
    const crawlPromises = links.map(linkInfo => crawlSingleLink(linkInfo));
    const results = await Promise.allSettled(crawlPromises);
    
    return results
        .filter(result => result.status === 'fulfilled' && result.value.status === 'success')
        .map(result => result.value);
}

async function enhancedDuckDuckGoSearch(query) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };
        
        const { data } = await axios.get(searchUrl, { headers, timeout: 12000 });
        const $ = cheerio.load(data);
        const results = [];
        
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
                // Ignore invalid URLs
            }
        });
        
        return results;
    } catch (error) {
        console.error('❌ DuckDuckGo search failed:', error.message);
        return [];
    }
}

function isLowQualityDomain(url) {
    const lowQualityDomains = [
        'pinterest.com', 'instagram.com', 'twitter.com', 'facebook.com',
        'youtube.com', 'tiktok.com', 'reddit.com'
    ];
    
    return lowQualityDomains.some(domain => url.includes(domain));
}

function sanitizeQuery(query) {
    const instructionalWords = [
        'explain about', 'explain', 'what is', 'what are', 'who is', 'who are', 
        'tell me about', 'give me information on', 'define', 'definition of'
    ];
    
    let sanitized = query.toLowerCase().trim();
    for (const word of instructionalWords) { 
        if (sanitized.startsWith(word + ' ')) { 
            sanitized = sanitized.substring(word.length).trim(); 
            break; 
        } 
    }
    return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
}

// --- MAIN API ROUTE ---
app.post('/api', async (req, res) => {
    const { query } = req.body;
    if (!query) { 
        return res.status(400).json({ error: 'Query is required.' }); 
    }

    const startTime = Date.now();
    console.log(`\n--- [ENHANCED PIPELINE START] ---`);
    console.log(`[PIPELINE] Query: "${query}"`);

    try {
        // Step 1: Search
        console.log(`[PIPELINE] Step 1: Searching...`);
        const searchQuery = sanitizeQuery(query);
        const searchResults = await enhancedDuckDuckGoSearch(searchQuery);

        if (!searchResults || searchResults.length === 0) {
            console.log(`[PIPELINE] ⚠️ No sources found for: "${searchQuery}"`);
            return res.json({ 
                summary: "I couldn't find any relevant sources online for your query. Please try rephrasing your question or using different keywords.", 
                key_points: [], 
                sources: [], 
                follow_up_questions: [],
                all_search_results: [] 
            });
        }
        
        // Step 2: Extract content
        const uniqueLinks = Array.from(new Map(searchResults.map(item => [item.link, item])).values());
        const linksToAnalyze = uniqueLinks.slice(0, 6); // Analyze more sources
        console.log(`[PIPELINE] Step 2: Extracting content from ${linksToAnalyze.length} sources...`);
        
        const extracted = await crawlWithRequestsOnly(linksToAnalyze);

        if (extracted.length === 0) {
            console.log(`[PIPELINE] ⚠️ No content extracted from sources.`);
            return res.status(500).json({ 
                error: "I found sources but couldn't extract their content. This might be due to website restrictions or network issues. Please try again." 
            });
        }

        // Step 3: AI Analysis
        console.log(`[PIPELINE] Step 3: Generating AI analysis from ${extracted.length} sources...`);
        
        const combinedText = extracted.map((c, i) => 
            `--- Source ${i + 1}: ${c.title} ---\n${c.textContent}\n\n`
        ).join('');
        
        const prompt = `You are an expert research analyst. Analyze the provided web sources to comprehensively answer the user's query.

USER'S QUERY: "${query}"

Generate a response in valid JSON format with this exact structure:

{
    "summary": "A comprehensive, well-structured summary that directly answers the user's query. Make it informative and easy to understand.",
    "key_points": ["Array of 4-6 crucial bullet points highlighting the most important information"],
    "sources_used": [1, 2, 3],
    "follow_up_questions": ["Array of 3 insightful follow-up questions related to the topic"]
}

IMPORTANT REQUIREMENTS:
- Your response must be ONLY the JSON object, no additional text
- Base your answer ONLY on the provided sources
- Make the summary comprehensive but concise (2-3 paragraphs)
- Ensure key_points are specific and actionable
- sources_used should reference source numbers (1-based indexing)
- Include all required JSON keys

--- SOURCES ---
${combinedText}
--- END SOURCES ---`;

        const aiResponse = await makeGeminiRequest(prompt);
        
        let parsed;
        try {
            parsed = JSON.parse(aiResponse);
        } catch (err) {
            console.error("❌ Invalid JSON from AI:", aiResponse.substring(0, 500));
            return res.status(500).json({ 
                error: "The AI service returned an invalid response. Please try again." 
            });
        }
        
        // Prepare final response
        const sourcesUsed = parsed.sources_used ? 
            parsed.sources_used.map(num => extracted[num - 1] || null).filter(Boolean) : [];
        
        const finalResponse = {
            summary: parsed.summary || "Unable to generate summary.",
            key_points: parsed.key_points || [],
            sources: sourcesUsed.map(s => ({ title: s.title, link: s.link })),
            follow_up_questions: parsed.follow_up_questions || [],
            all_search_results: uniqueLinks.slice(0, 10) // Limit results
        };

        const endTime = Date.now();
        const executionTime = (endTime - startTime) / 1000;
        console.log(`[PIPELINE] ✅ Pipeline completed in ${executionTime}s (${extracted.length} sources)`);
        
        res.json(finalResponse);

        // Background history save
        setImmediate(async () => {
            try {
                const newHistory = new History({ query });
                await newHistory.save();
            } catch (dbError) {
                console.error("Background DB save failed:", dbError);
            }
        });

    } catch (err) {
        console.error("❌ [PIPELINE] Critical error:", err);
        
        if (err.message.includes('Rate limit')) {
            return res.status(429).json({ 
                error: err.message,
                retryAfter: 60
            });
        }
        
        if (err.message.includes('Service temporarily unavailable')) {
            return res.status(503).json({ 
                error: "AI service is temporarily overloaded. Please try again in a few moments." 
            });
        }
        
        if (!res.headersSent) {
            res.status(500).json({ 
                error: "An unexpected error occurred. Please try again." 
            });
        }
    }
});

// --- FILE ANALYSIS ROUTE ---
app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
    console.log('\n[FILE ANALYSIS] Request received');
    
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
    }

    try {
        const file = req.file;
        console.log(`[FILE ANALYSIS] Processing: ${file.originalname} (${file.mimetype})`);

        let extractedText = '';

        // Handle different file types
        if (file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
            extractedText = file.buffer.toString('utf-8');
        } 
        else if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
            console.log('[FILE ANALYSIS] 📄 Extracting text from PDF...');
            const data = await pdfParse(file.buffer);
            extractedText = data.text;
        } 
        else {
            return res.status(400).json({ 
                error: "Unsupported file type. Please upload a .txt or .pdf file." 
            });
        }

        if (!extractedText || !extractedText.trim()) {
            return res.status(400).json({ 
                error: "Could not extract text from the file. It might be empty or an image-based PDF." 
            });
        }

        console.log(`[FILE ANALYSIS] ✅ Extracted ${extractedText.length} characters`);

        const prompt = `You are an expert document analyst. Analyze the following document and provide insights.

Generate a response in valid JSON format:

{
  "summary": "A comprehensive summary of the document's main content and purpose",
  "key_points": ["Array of 4-6 key takeaways from the document"],
  "document_type": "Type of document (e.g., research paper, report, article, etc.)",
  "main_topics": ["Array of main topics covered"]
}

Your response must be ONLY the JSON object.

--- DOCUMENT TEXT ---
${extractedText.substring(0, 20000)}
--- END DOCUMENT TEXT ---`;
        
        const responseText = await makeGeminiRequest(prompt, true);
        
        let analysisData;
        try {
            analysisData = JSON.parse(responseText);
        } catch (err) {
            console.error("❌ Invalid JSON from file analysis:", responseText.substring(0, 500));
            return res.status(500).json({ 
                error: "Failed to analyze the file. Please try again." 
            });
        }

        res.json({
            summary: analysisData.summary || "No summary generated.",
            key_points: analysisData.key_points || [],
            document_type: analysisData.document_type || "Unknown",
            main_topics: analysisData.main_topics || [],
            sources: [{ title: file.originalname, link: '#' }],
            follow_up_questions: [],
            all_search_results: []
        });

    } catch (error) {
        console.error("❌ File analysis error:", error);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ 
                error: error.message,
                retryAfter: 60
            });
        }
        
        res.status(500).json({ 
            error: "An error occurred during file analysis. Please try again." 
        });
    }
});

// --- HISTORY ROUTES ---
app.get('/api/history', async (req, res) => {
    try {
        const history = await History.find({}).sort({ createdAt: -1 }).limit(50);
        res.json(history);
    } catch (error) {
        console.error('History fetch error:', error);
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
        console.error('History save error:', error);
        res.status(500).json({ error: 'Failed to save history' });
    }
});

app.delete('/api/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await History.findByIdAndDelete(id);
        res.json({ message: 'History item deleted' });
    } catch (error) {
        console.error('History delete error:', error);
        res.status(500).json({ error: 'Failed to delete history item' });
    }
});

app.put('/api/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: 'Query text is required' });
        
        await History.findByIdAndUpdate(id, { query });
        res.json({ message: 'History item updated' });
    } catch (error) {
        console.error('History update error:', error);
        res.status(500).json({ error: 'Failed to update history item' });
    }
});

// --- ACADEMIC SEARCH ROUTES ---
const coreApiKey = process.env.CORE_API_KEY;

async function searchOpenAlex(query) {
    const userEmail = process.env.CONTACT_EMAIL || 'contact@example.com';
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&mailto=${userEmail}`;
    
    try {
        const response = await axios.get(url, { timeout: 15000 });
        return response.data;
    } catch (error) {
        console.error('OpenAlex search error:', error.message);
        throw new Error('Failed to search OpenAlex');
    }
}

async function searchCore(query) {
    if (!coreApiKey) {
        throw new Error('CORE API key not configured');
    }
    
    const url = `https://api.core.ac.uk/v3/search/works`;
    try {
        const response = await axios.post(url, { q: query }, {
            headers: { 'Authorization': `Bearer ${coreApiKey}` },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        console.error('CORE search error:', error.response?.data || error.message);
        throw new Error('Failed to search CORE');
    }
}

app.get('/', (req, res) => {
    res.json({ 
        message: 'NIT Chatbot API is running successfully!',
        version: '2.0.0',
        endpoints: ['/api', '/api/analyze-file', '/api/history', '/search']
    });
});

app.get('/search', async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
    }
    
    try {
        const results = await Promise.allSettled([
            searchOpenAlex(query),
            coreApiKey ? searchCore(query) : Promise.resolve({ results: [] })
        ]);
        
        const openAlexResults = results[0].status === 'fulfilled' ? results[0].value : { results: [] };
        const coreResults = results[1].status === 'fulfilled' ? results[1].value : { results: [] };
        
        res.json({
            message: 'Academic search completed',
            data: {
                openAlex: openAlexResults.results?.slice(0, 10).map(work => ({ 
                    title: work.title, 
                    doi: work.doi,
                    year: work.publication_year 
                })) || [],
                core: coreResults.results?.slice(0, 10).map(work => ({ 
                    title: work.title, 
                    year: work.yearPublished 
                })) || []
            }
        });
    } catch (error) {
        console.error('Academic search error:', error);
        res.status(500).json({ error: 'Academic search failed' });
    }
});

// --- HEALTH CHECK ENDPOINT ---
app.get('/health', async (req, res) => {
    try {
        const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
        
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            database: dbStatus,
            driverPool: driverPool.length,
            uptime: process.uptime()
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected successfully'))
    .catch(err => {
        console.error('❌ MongoDB connection failed:', err);
        process.exit(1);
    });

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await cleanupDriverPool();
    mongoose.connection.close(() => {
        console.log('MongoDB connection closed');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM...');
    await cleanupDriverPool();
    mongoose.connection.close(() => {
        console.log('MongoDB connection closed');
        process.exit(0);
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`🚀 NIT Chatbot Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});
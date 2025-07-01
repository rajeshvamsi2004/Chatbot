// index.js (or your main server file)

const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
require('dotenv').config();

const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const History = require('./models/History.js');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ▼▼▼ NEW CODE BLOCK START ▼▼▼

// --- Job Search Function ---
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
        // The JSearch API wraps the job listings in a `data` property
        return response.data.data; 
    } catch (error) {
        console.error("❌ JSearch API Error:", error.message);
        // Return null or an empty array to indicate failure
        return null; 
    }
}

// --- New Job Search Endpoint ---
app.get('/jobs', async (req, res) => {
    // Get the job title and location from the request body
    const { query, location } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Job "query" is required.' });
    }

    // Call our new job search function
    const jobs = await searchJobs(query, location);

    if (jobs) {
        // If we got jobs, send them back to the client
        res.status(200).json(jobs);
    } else {
        // If there was an error, send a server error status
        res.status(500).json({ error: 'Failed to fetch job listings.' });
    }
});

// ▲▲▲ NEW CODE BLOCK END ▲▲▲


// --- Sanitize query ---
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

function decodeDuckDuckGoUrl(href) {
    try {
        const urlObj = new URL('https://duckduckgo.com' + href); // make it full URL
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
            const rawLink = $(el).attr('href'); // DuckDuckGo redirect link
            const realLink = decodeDuckDuckGoUrl(rawLink); // Extract real URL
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


// --- Crawl and extract content from article ---
async function crawlAndExtract(url, title) {
    console.log(`\t[CRAWL] Attempting to crawl: ${url}`);
    try {
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
            }
        });
        const dom = new JSDOM(response.data, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article && article.textContent) {
            console.log(`\t[CRAWL] ✅ SUCCESS for: ${url}`);
            // Limit content to avoid overly large prompts
            return {
                title,
                textContent: article.textContent.trim().substring(0, 8000) 
            };
        }

        console.log(`\t[CRAWL] ⚠️ No readable content for: ${url}`);
        return null;
    } catch (err) {
        console.log(`\t[CRAWL] ❌ ERROR: ${url} | ${err.message}`);
        return null;
    }
}

// --- Main API Endpoint ---
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
        const linksToAnalyze = uniqueSources.slice(0, 7);

        console.log(`[2/5] Crawling top ${linksToAnalyze.length} sources...`);
        const crawlPromises = linksToAnalyze.map(item => crawlAndExtract(item.link, item.title));
        const crawledSettled = await Promise.allSettled(crawlPromises);

        const extracted = [];
        crawledSettled.forEach((result, index) => {
            const originalSource = linksToAnalyze[index];
            if (result.status === 'fulfilled' && result.value && result.value.textContent) {
                // Crawling was successful, use the full extracted text
                extracted.push(result.value);
            } else {
                // Crawling failed, use the search result snippet as a fallback
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
        
        // ▼▼▼ MODIFIED PROMPT TO INCLUDE follow_up_questions ▼▼▼
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
        // ▼▼▼ MODIFIED RESPONSE TO INCLUDE follow_up_questions ▼▼▼
        res.json({
            summary: parsed.summary,
            key_points: parsed.key_points,
            sources: sourcesUsed,
            follow_up_questions: parsed.follow_up_questions || [], // Add this line
            all_search_results: uniqueSources
        });

    } catch (err) {
        console.error("❌ Pipeline Error:", err.message);
        res.status(500).json({ error: "An unexpected error occurred during the analysis process." });
    }
});


// --- History Routes ---
app.post('/api/history', async (req, res) => { try { const { query } = req.body; if (!query) return res.status(400).json({ msg: 'Query is required.' }); const saved = await new History({ query }).save(); res.status(201).json(saved); } catch (error) { res.status(500).json({ msg: 'Failed to save history.' }); } });
app.get('/api/history', async (req, res) => { try { const all = await History.find().sort({ createdAt: -1 }); res.status(200).json(all); } catch (error) { res.status(500).json({ msg: 'Error fetching history.' }); } });
app.delete('/api/history/:id', async (req, res) => { try { const deleted = await History.findByIdAndDelete(req.params.id); if (!deleted) return res.status(404).json({ message: 'Not found' }); res.status(200).json({ message: 'Deleted successfully' }); } catch (error) { res.status(500).json({ message: 'Error deleting item' }); } });
app.put('/api/history/:id', async (req, res) => { try { const { query } = req.body; const updated = await History.findByIdAndUpdate(req.params.id, { query }, { new: true }); if (!updated) return res.status(404).json({ message: 'Item not found' }); res.status(200).json(updated); } catch (error) { res.status(500).json({ message: 'Error updating item' }); } });

// --- MongoDB Connection & Server Start ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
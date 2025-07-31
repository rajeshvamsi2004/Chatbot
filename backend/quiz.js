const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer')
const app = express();
const port = 5005;

app.use(cors());
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
    throw new Error("FATAL ERROR: GEMINI_API_KEY is not defined.");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- ADD RATE LIMITING AND ERROR HANDLING FROM CHATBOT.JS ---
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

const rateLimiter = new RateLimiter(15, 60000); // 15 requests per minute
const geminiCircuitBreaker = new CircuitBreaker(3, 30000);

// Enhanced Gemini request function with multiple models and retries
async function makeGeminiRequest(prompt, retries = 3) {
    const models = [
        { name: "gemini-1.5-flash-8b", maxTokens: 2048, temperature: 0.3 },
        { name: "gemini-1.5-flash", maxTokens: 2048, temperature: 0.3 },
        { name: "gemini-1.5-pro", maxTokens: 2048, temperature: 0.4 },
        { name: "gemini-1.5-pro-latest", maxTokens: 2048, temperature: 0.4 },
        { name: "gemini-1.5-flash-latest", maxTokens: 2048, temperature: 0.3 }
    ];

    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
        const modelConfig = models[modelIndex];
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await geminiCircuitBreaker.call(async () => {
                    rateLimiter.checkLimit();
                    
                    const maxPromptLength = 25000;
                    const truncatedPrompt = prompt.length > maxPromptLength 
                        ? prompt.substring(0, maxPromptLength) + "\n\n[Content truncated due to length limits]"
                        : prompt;
                    
                    console.log(`[GEMINI] Trying ${modelConfig.name} (attempt ${attempt}/${retries})`);
                    
                    const model = genAI.getGenerativeModel({ 
                        model: modelConfig.name,
                        generationConfig: { 
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

// Updated quiz generation endpoint
app.post('/generate-quiz', async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] --> Quiz request received.`);
    try {
        const { text, level } = req.body;

        if (!text || !level) {
            return res.status(400).json({ error: "Missing 'text' or 'level' in request body." });
        }

        const prompt = `Based on the following text, create a 5-question multiple-choice quiz. The difficulty of the questions should be '${level}'. 
For a 'Basic' level, ask direct, factual questions. 
For 'Intermediate', ask questions that require some inference. 
For 'Hard', ask questions that require synthesizing information or deeper analysis.
The provided text is: "${text}".
Return ONLY a valid JSON object with a key "quiz" which is an array of objects. Each object must have these exact keys: "question" (string), "options" (array of 4 strings), "correctAnswerIndex" (number), and "explanation" (string).`;
        
        const responseText = await makeGeminiRequest(prompt);

        console.log(`[OK] Received response from Gemini.`);
        const cleanedJsonString = responseText.replace(/```json|```/g, '').trim();
        const quizJson = JSON.parse(cleanedJsonString);
        console.log(`[SUCCESS] Sending ${level} quiz to frontend.`);
        res.json(quizJson);

    } catch (error) {
        console.error('---!!! A QUIZ GENERATION ERROR OCCURRED !!!---');
        console.error("Error details: ", error);
        
        // Handle specific error types
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ 
                error: error.message,
                retryAfter: 60
            });
        }
        
        if (error.message.includes('Service temporarily unavailable')) {
            return res.status(503).json({ 
                error: "AI service is temporarily overloaded. Please try again in a few moments." 
            });
        }
        
        res.status(500).json({ 
            error: 'Quiz generation failed. The AI models may be temporarily unavailable. Please try again.' 
        });
    }
});

// Updated recommendations endpoint
app.post('/generate-recommendations', async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] --> Recommendation request received.`);
    try {
        const { text, level, incorrectQuestions } = req.body;

        if (!text || !incorrectQuestions) {
            return res.status(400).json({ error: "Missing 'text' or 'incorrectQuestions' in request body." });
        }

        const incorrectQuestionsString = incorrectQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n');

        const prompt = `
            You are a friendly and encouraging tutor. A student has just taken a ${level}-level quiz based on a specific text and did not pass. 
            
            The source text is: """${text}"""

            The student struggled with these specific questions:
            """${incorrectQuestionsString}"""

            Your task is to provide helpful feedback. Return ONLY a valid JSON object with the following three keys:
            1. "message": A short, encouraging message (2-3 sentences) acknowledging their effort and motivating them to review.
            2. "conceptsToReview": An array of 3-4 key concepts or topics from the source text that they should focus on, based on the questions they got wrong.
            3. "suggestedCourses": An array of 3 generic, real-world search terms for online courses or YouTube playlists that would help them understand the broader subject. For example, if the topic is Hash Maps, suggest "Introduction to Data Structures" or "Algorithms and Big O Notation".

            Example JSON structure:
            {
              "message": "You're on the right track!...",
              "conceptsToReview": ["The definition of a hash function", "Collision handling methods"],
              "suggestedCourses": ["Data Structures 101", "Beginner's Guide to Algorithms", "Computer Science Fundamentals"]
            }
        `;
        
        const responseText = await makeGeminiRequest(prompt);

        console.log(`[OK] Received recommendation from Gemini.`);
        const cleanedJsonString = responseText.replace(/```json|```/g, '').trim();
        const recommendationJson = JSON.parse(cleanedJsonString);
        console.log(`[SUCCESS] Sending recommendation to frontend.`);
        res.json(recommendationJson);

    } catch (error) {
        console.error('---!!! A RECOMMENDATION ERROR OCCURRED !!!---');
        console.error("Error details: ", error);
        
        // Handle specific error types
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ 
                error: error.message,
                retryAfter: 60
            });
        }
        
        if (error.message.includes('Service temporarily unavailable')) {
            return res.status(503).json({ 
                error: "AI service is temporarily overloaded. Please try again in a few moments." 
            });
        }
        
        res.status(500).json({ 
            error: 'Failed to generate recommendations. The AI models may be temporarily unavailable.' 
        });
    }
});

// File analysis endpoint (keep existing logic but use enhanced Gemini function)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file was uploaded." });
    }

    try {
        let extractedText = '';
        const file = req.file;

        // Text extraction logic (keep existing)
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
            const data = await pdf(file.buffer);
            extractedText = data.text;
        } else if (file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt')) {
            extractedText = file.buffer.toString('utf-8');
        } else {
            return res.status(400).json({ error: "Unsupported file type. Please upload a .txt or .pdf file." });
        }

        if (!extractedText.trim()) {
            return res.status(400).json({ error: "Could not extract any text from the file. It might be empty or an image-based PDF." });
        }
        
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

        const responseText = await makeGeminiRequest(prompt);
        
        let analysisData;
        try {
            const cleanJsonString = responseText.replace(/```json|```/g, '').trim();
            analysisData = JSON.parse(cleanJsonString);
        } catch (e) {
            console.error("Failed to parse Gemini JSON response:", e);
            analysisData = {
                summary: "The AI returned a response, but it was not in the expected JSON format. Here is the raw response: " + responseText,
                key_points: []
            };
        }
        
        const finalResponse = {
            ...analysisData,
            sources: [],
            all_search_results: [],
            follow_up_questions: []
        };

        res.json(finalResponse);

    } catch (error) {
        console.error("Error during file analysis:", error);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ 
                error: error.message,
                retryAfter: 60
            });
        }
        
        if (error.message.includes('Service temporarily unavailable')) {
            return res.status(503).json({ 
                error: "AI service is temporarily overloaded. Please try again in a few moments." 
            });
        }
        
        res.status(500).json({ error: "An internal server error occurred during file analysis." });
    }
});

app.listen(port, () => {
    console.log(`✅ Enhanced Quiz Backend server running at http://localhost:${port}.`);
    console.log(`🛡️ Circuit breaker and rate limiting enabled`);
});
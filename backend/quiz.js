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

async function generateWithModel(modelName, prompt) {
    console.log(`[ATTEMPTING] Trying model: ${modelName}...`);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    return result.response.text();
}

app.post('/generate-quiz', async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] --> Request received.`);
    try {
        // --- FIX: Destructure both text AND level from the request body ---
        const { text, level } = req.body;

        if (!text || !level) {
            return res.status(400).json({ error: "Missing 'text' or 'level' in request body." });
        }

        // --- FIX: Inject the 'level' into the prompt ---
        const prompt = `Based on the following text, create a 5-question multiple-choice quiz. The difficulty of the questions should be '${level}'. 
For a 'Basic' level, ask direct, factual questions. 
For 'Intermediate', ask questions that require some inference. 
For 'Hard', ask questions that require synthesizing information or deeper analysis.
The provided text is: "${text}".
Return ONLY a valid JSON object with a key "quiz" which is an array of objects. Each object must have these exact keys: "question" (string), "options" (array of 4 strings), "correctAnswerIndex" (number), and "explanation" (string).`;
        
        let responseText;
        try {
            responseText = await generateWithModel("gemini-1.5-pro-latest", prompt);
        } catch (error) {
            console.warn(`[FALLBACK] Model 'gemini-1.5-pro-latest' failed. Error: ${error.message}.`);
            console.warn("Trying fallback model 'gemini-1.5-flash-latest'.");
            responseText = await generateWithModel("gemini-1.5-flash-latest", prompt);
        }

        console.log(`[OK] Received response from Gemini.`);
        const cleanedJsonString = responseText.replace(/```json|```/g, '').trim();
        const quizJson = JSON.parse(cleanedJsonString);
        console.log(`[SUCCESS] Sending ${level} quiz to frontend.`);
        res.json(quizJson);

    } catch (error) {
        console.error('---!!! A FATAL ERROR OCCURRED !!!---');
        console.error("Both models failed or JSON parsing failed. The final error is: ", error);
        res.status(500).json({ error: 'Both primary and fallback models failed, or the response was not valid JSON. Please check your Google Cloud project billing or quota.' });
    }
});

app.post('/generate-recommendations', async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] --> Recommendation request received.`);
    try {
        const { text, level, incorrectQuestions } = req.body;

        if (!text || !incorrectQuestions) {
            return res.status(400).json({ error: "Missing 'text' or 'incorrectQuestions' in request body." });
        }

        // Create a string of the questions the user got wrong.
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
        
        // We can use the faster model for this task
        const responseText = await generateWithModel("gemini-1.5-flash-latest", prompt);

        console.log(`[OK] Received recommendation from Gemini.`);
        const cleanedJsonString = responseText.replace(/```json|```/g, '').trim();
        const recommendationJson = JSON.parse(cleanedJsonString);
        console.log(`[SUCCESS] Sending recommendation to frontend.`);
        res.json(recommendationJson);

    } catch (error) {
        console.error('---!!! A RECOMMENDATION ERROR OCCURRED !!!---');
        console.error("The error is: ", error);
        res.status(500).json({ error: 'Failed to generate recommendations. The AI model may be temporarily unavailable.' });
    }
});
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Gemini API Setup ---
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not defined in the .env file");
}
// --- API Endpoint for File Analysis ---
// The 'upload.single('file')' part tells multer to expect one file named 'file'
app.post('/api/analyze-file', upload.single('file'), async (req, res) => {
  // Check if a file was uploaded
  if (!req.file) {
    return res.status(400).json({ error: "No file was uploaded." });
  }

  try {
    let extractedText = '';
    const file = req.file;

    // --- Text Extraction Logic ---
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
    
    // --- Analysis with Gemini ---
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

    const result = await geminiModel.generateContent(prompt);
    const responseText = result.response.text();
    
    let analysisData;
    try {
        // Gemini often wraps JSON in markdown, so we clean it up before parsing
        const cleanJsonString = responseText.replace(/```json|```/g, '').trim();
        analysisData = JSON.parse(cleanJsonString);
    } catch (e) {
        console.error("Failed to parse Gemini JSON response:", e);
        // Fallback if Gemini doesn't return valid JSON
        analysisData = {
            summary: "The AI returned a response, but it was not in the expected JSON format. Here is the raw response: " + responseText,
            key_points: []
        };
    }
    
    // Add empty arrays to match the data structure your frontend expects
    const finalResponse = {
        ...analysisData,
        sources: [],
        all_search_results: [],
        follow_up_questions: []
    };

    res.json(finalResponse);

  } catch (error) {
    console.error("Error during file analysis:", error);
    res.status(500).json({ error: "An internal server error occurred during file analysis." });
  }
});


app.listen(port, () => {
    console.log(`✅ Backend server running at http://localhost:${port}.`);
});
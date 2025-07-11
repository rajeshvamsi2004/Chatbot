const express = require('express');
const { translate } = require('@vitalets/google-translate-api');
const googleTTS = require('google-tts-api');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const port = 5002;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Step 1: Get Gemini explanation (No changes)
async function explainWithGemini(topic) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
    const prompt = `You're an expert podcast narrator. Explain the topic "${topic}" in a way that is engaging, easy to understand, and ideal for listening. Do not just summarize—explain with examples, analogies, and a friendly tone.`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    console.log(`[Gemini] Explained topic: ${topic}`);
    return text;
  } catch (err) {
    console.error('[Gemini Error]', err);
    return null;
  }
}

// Step 2: Translate and Generate TTS Audio (UPDATED with the fix)
async function translateAndSpeak(text, targetLang) {
    try {
        const { text: translatedText } = await translate(text, { to: targetLang });
        const sentences = translatedText.match(/[^.!?]+[.!?]+/g) || [translatedText];
        console.log(`[Audio] Text split into ${sentences.length} sentences for processing.`);

        const audioBuffers = [];

        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            if (!sentence) continue; // Skip any empty sentences

            console.log(`[Audio] Generating audio for sentence ${i + 1}/${sentences.length}...`);

            // --- THIS IS THE FIX ---
            // Use getAllAudioBase64 instead of getAudioBase64.
            // This automatically handles sentences longer than 200 characters.
            const audioDataObjects = await googleTTS.getAllAudioBase64(sentence, {
                lang: targetLang,
                slow: false,
                timeout: 10000,
            });

            // Process the results from getAllAudioBase64
            for (const chunk of audioDataObjects) {
                audioBuffers.push(Buffer.from(chunk.base64, 'base64'));
            }
            // ---------------------

            // The delay is still important to prevent rate-limiting.
            await sleep(500);
        }

        const finalAudioBuffer = Buffer.concat(audioBuffers);
        console.log(`✅ [Audio] Audio generated successfully for language: ${targetLang}`);
        return finalAudioBuffer;

    } catch (err) {
        console.error('[Translation/TTS Error]', err);
        return null;
    }
}

// Unified API Endpoint (No changes)
app.post('/podcast', async (req, res) => {
  const { topic, targetLanguage } = req.body;

  if (!topic || !targetLanguage) {
    return res.status(400).json({ error: 'Missing "topic" or "targetLanguage" in the request body.' });
  }

  const explainedText = await explainWithGemini(topic);

  if (!explainedText) {
    return res.status(500).json({ error: 'Failed to get an explanation from the AI model.' });
  }

  const audioBuffer = await translateAndSpeak(explainedText, targetLanguage);

  if (!audioBuffer) {
    return res.status(500).json({ error: 'Failed to translate text or generate audio.' });
  }
  
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(audioBuffer);
});

app.listen(port, () => {
  console.log(`🎙️  Podcast Server running at http://localhost:${port}`);
});
import React, { useState, useRef } from 'react';
 // optional for styling

const Podcast = ({ topic }) => {
  const [language, setLanguage] = useState('en');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const audioRef = useRef(null);

  const handleGenerate = async () => {
    if (!topic) return;
    setIsLoading(true);
    setError(null);

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    try {
      const res = await fetch('http://localhost:5002/podcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, targetLanguage: language })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || 'Audio generation failed');
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play();

    } catch (err) {
      console.error(err);
      setError(`Failed to generate audio: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="podcast-generator">
      <h3>🎙️ Listen to Podcast Explanation</h3>
      <select value={language} onChange={(e) => setLanguage(e.target.value)}>
        <option value="en">English</option>
        <option value="hi">Hindi</option>
        <option value="te">Telugu</option>
        <option value="ta">Tamil</option>
        <option value="es">Spanish</option>
      </select>
      <button onClick={handleGenerate} disabled={isLoading || !topic}>
        {isLoading ? 'Generating...' : 'Play Podcast'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
};

export default Podcast;

import React, { useState } from 'react';
import './Chatbot.css';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUp, faPaperclip } from '@fortawesome/free-solid-svg-icons';
import axios from 'axios';

const Chatbot = () => {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState('');

  const handleSend = async () => {
    if (!query.trim()) return;

    try {
      const res = await axios.post('http://localhost:5007/search', { query });

      const formatted = res.data.map((item, index) =>
        `${index + 1}. ${item.title}\n${item.snippet}\n${item.link}`
      ).join('\n\n');

      setResponse(formatted);
    } catch (err) {
      console.error(err);
      setResponse('❌ Error getting response from backend');
    }
  };

  return (
    <div className="chatbot-wrapper">
      <div className="chatbot-body">
        <pre>{response}</pre>
      </div>

      <div className="chatbot-input-container">
        <label htmlFor="file-upload" className="icon-left">
          <FontAwesomeIcon icon={faPaperclip} />
        </label>
        <input type="file" id="file-upload" hidden />

        <input
          type="text"
          placeholder="Message Chatbot..."
          className="chatbot-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        />

        <button className="icon-right" onClick={handleSend}>
          <FontAwesomeIcon icon={faArrowUp} />
        </button>
      </div>
    </div>
  );
};

export default Chatbot;

import React from 'react';
import './Sidebar.css';

const Sidebar = () => {
  return (
    <div className="sidebar-container">
      <h2 className="sidebar-title">Chatbot</h2>

      <button className="new-chat-btn">
        + New Chat
      </button>

      <div className="chat-history">
        <div className="chat-item">Chat 1</div>
        <div className="chat-item">Chat 2</div>
        <div className="chat-item">Chat 3</div>
        <div className="chat-item">Chat 4</div>
      </div>
    </div>
  );
};

export default Sidebar;

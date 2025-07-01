const mongoose = require('mongoose');

const historySchema = new mongoose.Schema({
  query: {
    type: String,
    required: true
  }
}, { 
  timestamps: true, // <-- This is the standard Mongoose way. It's better.
  collection: 'Chatbotcollection' // This is fine if you want a specific collection name.
});

module.exports = mongoose.model('History', historySchema);
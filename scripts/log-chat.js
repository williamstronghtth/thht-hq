#!/usr/bin/env node
/**
 * Log chat message to Team HQ Dashboard
 * 
 * Usage:
 *   node log-chat.js --from ryan --to william --text "Message here"
 *   
 * Or via environment:
 *   HQ_URL=https://thht-hq.onrender.com node log-chat.js ...
 */

const HQ_URL = process.env.HQ_URL || 'https://thht-hq.onrender.com';

async function logChat(from, to, text) {
  try {
    const res = await fetch(`${HQ_URL}/api/chatlog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, text })
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    
    const data = await res.json();
    console.log(`✅ Logged: ${from} → ${to}: "${text.slice(0, 50)}..."`);
    return data;
  } catch (err) {
    console.error(`❌ Failed to log chat: ${err.message}`);
    throw err;
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  let from = 'ryan';
  let to = 'william';
  let text = '';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      from = args[++i];
    } else if (args[i] === '--to' && args[i + 1]) {
      to = args[++i];
    } else if (args[i] === '--text' && args[i + 1]) {
      text = args[++i];
    }
  }
  
  if (!text) {
    console.log('Usage: node log-chat.js --from ryan --to william --text "Message"');
    process.exit(1);
  }
  
  logChat(from, to, text)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { logChat, HQ_URL };

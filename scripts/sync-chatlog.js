#!/usr/bin/env node
/**
 * Sync agent session messages to Team HQ Dashboard
 * 
 * Reads recent inter-agent messages from OpenClaw sessions
 * and posts them to the HQ chatlog API.
 * 
 * Usage:
 *   node sync-chatlog.js [--hours 24] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const HQ_URL = process.env.HQ_URL || 'https://thht-hq.onrender.com';
const OPENCLAW_DIR = '/root/.openclaw';
const STATE_FILE = path.join(__dirname, '..', 'data', 'sync-state.json');

// Agent name mappings
const AGENT_NAMES = {
  'main': 'william',
  'ryan-chen': 'ryan'
};

function loadSyncState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { lastSync: 0, syncedMessages: [] };
}

function saveSyncState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function parseSessionFile(filePath, agentId) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(l => l);
  const messages = [];
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      
      // Only process user/assistant messages with timestamps
      if (!parsed.timestamp) continue;
      if (parsed.role !== 'user' && parsed.role !== 'assistant') continue;
      
      // Extract text content
      let text = '';
      if (typeof parsed.content === 'string') {
        text = parsed.content;
      } else if (Array.isArray(parsed.content)) {
        text = parsed.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
      }
      
      // Skip empty or system messages
      if (!text || text.length < 5) continue;
      
      // Skip messages that are clearly system/tool related
      if (text.startsWith('HEARTBEAT') || text.startsWith('NO_REPLY')) continue;
      
      // Determine from/to based on role and session context
      // For inter-agent messages, look for patterns
      const isInterAgent = text.includes('William') || text.includes('Ryan') || 
                           text.includes('agent:main') || text.includes('agent:ryan');
      
      if (!isInterAgent) continue; // Only sync inter-agent conversations
      
      const agentName = AGENT_NAMES[agentId] || agentId;
      const from = parsed.role === 'assistant' ? agentName : 'william'; // Assume user is William for main
      const to = from === 'william' ? 'ryan' : 'william';
      
      messages.push({
        from,
        to,
        text: text.slice(0, 500), // Truncate long messages
        timestamp: parsed.timestamp,
        hash: simpleHash(text + parsed.timestamp)
      });
    } catch (e) {
      // Skip malformed lines
    }
  }
  
  return messages;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash.toString(36);
}

async function postToHQ(message) {
  const res = await fetch(`${HQ_URL}/api/chatlog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      text: message.text
    })
  });
  
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  
  return res.json();
}

async function sync(options = {}) {
  const { hours = 24, dryRun = false } = options;
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  
  console.log(`\n🔍 Scanning sessions from last ${hours} hours...`);
  
  const state = loadSyncState();
  const allMessages = [];
  
  // Scan agent sessions
  const agentsDir = path.join(OPENCLAW_DIR, 'agents');
  if (!fs.existsSync(agentsDir)) {
    console.log('❌ No agents directory found');
    return;
  }
  
  const agentDirs = fs.readdirSync(agentsDir);
  
  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    
    const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    
    for (const file of sessionFiles) {
      const filePath = path.join(sessionsDir, file);
      const stats = fs.statSync(filePath);
      
      // Skip old sessions
      if (stats.mtimeMs < cutoff) continue;
      
      const messages = parseSessionFile(filePath, agentId);
      allMessages.push(...messages);
    }
  }
  
  // Filter to recent messages and dedupe
  const recentMessages = allMessages
    .filter(m => new Date(m.timestamp).getTime() > cutoff)
    .filter(m => !state.syncedMessages.includes(m.hash))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  console.log(`📨 Found ${recentMessages.length} new messages to sync`);
  
  if (recentMessages.length === 0) {
    console.log('✅ Already up to date');
    return;
  }
  
  if (dryRun) {
    console.log('\n🔍 DRY RUN - Messages that would be synced:');
    recentMessages.forEach(m => {
      console.log(`  ${m.from} → ${m.to}: "${m.text.slice(0, 60)}..."`);
    });
    return;
  }
  
  // Post messages to HQ
  let synced = 0;
  for (const msg of recentMessages) {
    try {
      await postToHQ(msg);
      state.syncedMessages.push(msg.hash);
      synced++;
      console.log(`✓ ${msg.from} → ${msg.to}`);
      await new Promise(r => setTimeout(r, 200)); // Rate limit
    } catch (err) {
      console.error(`✗ Failed: ${err.message}`);
    }
  }
  
  // Keep only last 500 synced hashes
  if (state.syncedMessages.length > 500) {
    state.syncedMessages = state.syncedMessages.slice(-500);
  }
  
  state.lastSync = Date.now();
  saveSyncState(state);
  
  console.log(`\n✅ Synced ${synced} messages to HQ`);
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1]) : 24;
  
  sync({ hours, dryRun }).catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
  });
}

module.exports = { sync };

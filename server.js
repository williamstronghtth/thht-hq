const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Data files
const OPENCLAW_DIR = '/root/.openclaw';
const TAKEAWAYS_FILE = path.join(__dirname, 'data', 'takeaways.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Initialize takeaways file
function loadTakeaways() {
  if (!fs.existsSync(TAKEAWAYS_FILE)) {
    const initial = { takeaways: [] };
    fs.writeFileSync(TAKEAWAYS_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(TAKEAWAYS_FILE, 'utf8'));
}

function saveTakeaways(data) {
  fs.writeFileSync(TAKEAWAYS_FILE, JSON.stringify(data, null, 2));
}

// Fallback agents for deployed environment (when OpenClaw config not available)
const FALLBACK_AGENTS = [
  { id: 'main', name: 'William Strong', avatar: '/avatars/william.jpg' },
  { id: 'ryan-chen', name: 'Ryan Chen', avatar: '/avatars/ryan-chen.jpg' }
];

// GET agents from openclaw.json (with fallback for deployed env)
app.get('/api/agents', (req, res) => {
  try {
    const configPath = path.join(OPENCLAW_DIR, 'openclaw.json');
    
    // Check if OpenClaw config exists (local dev)
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      const agents = config.agents.list.map(agent => ({
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace || config.agents.defaults?.workspace,
        avatar: `/avatars/${agent.id === 'main' ? 'william' : agent.id}.jpg`
      }));
      
      return res.json({ agents });
    }
    
    // Fallback for deployed environment (Render, etc.)
    res.json({ agents: FALLBACK_AGENTS });
  } catch (err) {
    // Return fallback on any error
    console.error('Error loading agents, using fallback:', err.message);
    res.json({ agents: FALLBACK_AGENTS });
  }
});

// GET sessions list
app.get('/api/sessions', (req, res) => {
  try {
    const sessions = [];
    const agentsDir = path.join(OPENCLAW_DIR, 'agents');
    
    if (!fs.existsSync(agentsDir)) {
      return res.json({ sessions: [] });
    }
    
    const agentDirs = fs.readdirSync(agentsDir);
    
    for (const agentId of agentDirs) {
      const sessionsDir = path.join(agentsDir, agentId, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;
      
      const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      
      for (const file of sessionFiles) {
        const filePath = path.join(sessionsDir, file);
        const stats = fs.statSync(filePath);
        const sessionId = file.replace('.jsonl', '');
        
        // Read first and last line for metadata
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l);
        
        let messageCount = 0;
        let lastMessage = null;
        let firstTimestamp = null;
        
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.role === 'user' || parsed.role === 'assistant') {
              messageCount++;
              if (!firstTimestamp && parsed.timestamp) {
                firstTimestamp = parsed.timestamp;
              }
              lastMessage = parsed;
            }
          } catch (e) {}
        }
        
        sessions.push({
          id: sessionId,
          agentId,
          file: file,
          messageCount,
          lastActivity: lastMessage?.timestamp || stats.mtimeMs,
          size: stats.size
        });
      }
    }
    
    // Sort by last activity
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    
    res.json({ sessions: sessions.slice(0, 50) }); // Limit to 50 most recent
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sessions', details: err.message });
  }
});

// GET session messages
app.get('/api/sessions/:agentId/:sessionId', (req, res) => {
  try {
    const { agentId, sessionId } = req.params;
    const filePath = path.join(OPENCLAW_DIR, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l);
    
    const messages = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.role === 'user' || parsed.role === 'assistant') {
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
          
          messages.push({
            role: parsed.role,
            content: text,
            timestamp: parsed.timestamp,
            model: parsed.model
          });
        }
      } catch (e) {}
    }
    
    res.json({ agentId, sessionId, messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load session', details: err.message });
  }
});

// GET takeaways
app.get('/api/takeaways', (req, res) => {
  try {
    const data = loadTakeaways();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load takeaways', details: err.message });
  }
});

// POST new takeaway
app.post('/api/takeaways', (req, res) => {
  try {
    const data = loadTakeaways();
    
    const takeaway = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      agent: req.body.agent || 'unknown',
      type: req.body.type || 'action', // action, insight, decision
      text: req.body.text || '',
      assignee: req.body.assignee || null,
      status: req.body.status || 'pending', // pending, in-progress, done, blocked
      confidence: req.body.confidence || null, // for insights
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    data.takeaways.unshift(takeaway); // Add to beginning
    saveTakeaways(data);
    
    res.status(201).json(takeaway);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create takeaway', details: err.message });
  }
});

// PUT update takeaway
app.put('/api/takeaways/:id', (req, res) => {
  try {
    const data = loadTakeaways();
    const idx = data.takeaways.findIndex(t => t.id === req.params.id);
    
    if (idx === -1) {
      return res.status(404).json({ error: 'Takeaway not found' });
    }
    
    data.takeaways[idx] = {
      ...data.takeaways[idx],
      ...req.body,
      id: data.takeaways[idx].id,
      createdAt: data.takeaways[idx].createdAt,
      updatedAt: new Date().toISOString()
    };
    
    saveTakeaways(data);
    res.json(data.takeaways[idx]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update takeaway', details: err.message });
  }
});

// DELETE takeaway
app.delete('/api/takeaways/:id', (req, res) => {
  try {
    const data = loadTakeaways();
    data.takeaways = data.takeaways.filter(t => t.id !== req.params.id);
    saveTakeaways(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete takeaway', details: err.message });
  }
});

// GET agent status (online/activity)
app.get('/api/agents/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const sessionsDir = path.join(OPENCLAW_DIR, 'agents', id, 'sessions');
    
    if (!fs.existsSync(sessionsDir)) {
      // Deployed environment - return simulated "online" status
      return res.json({ status: 'online', lastActivity: new Date().toISOString() });
    }
    
    // Find most recent session activity
    const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    let mostRecent = 0;
    
    for (const file of sessionFiles) {
      const stats = fs.statSync(path.join(sessionsDir, file));
      if (stats.mtimeMs > mostRecent) {
        mostRecent = stats.mtimeMs;
      }
    }
    
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const status = mostRecent > fiveMinutesAgo ? 'online' : 'away';
    
    res.json({ 
      status, 
      lastActivity: mostRecent ? new Date(mostRecent).toISOString() : null 
    });
  } catch (err) {
    // Fallback to online status on error
    res.json({ status: 'online', lastActivity: new Date().toISOString() });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`THHT HQ Dashboard running on port ${PORT}`);
});

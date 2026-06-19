const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'charon.sqlite');

let db;
function getDb() {
  if (!db) { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); db.pragma('journal_mode=WAL'); }
  return db;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => {
  try {
    const d = getDb();
    const openPositions = d.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status='open'").get().c;
    const totalPnL = d.prepare("SELECT COALESCE(SUM(pnl_sol),0) as s FROM dry_run_positions WHERE pnl_sol IS NOT NULL").get().s;
    const wins = d.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE pnl_sol>0").get().c;
    const losses = d.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE pnl_sol<0").get().c;
    const totalTrades = d.prepare("SELECT COUNT(*) as c FROM dry_run_trades").get().c;
    const totalCandidates = d.prepare("SELECT COUNT(*) as c FROM candidates").get().c;
    const totalDecisions = d.prepare("SELECT COUNT(*) as c FROM llm_decisions").get().c;
    const signalEvents = d.prepare("SELECT COUNT(*) as c FROM signal_events").get().c;
    const top = {};
    try {
      const s = d.prepare("SELECT key, value FROM settings WHERE key IN ('tradingMode','maxPositionSize','maxOpenPositions','slippageBps','minLiquiditySol')").all();
      s.forEach(r => top[r.key]=r.value);
    } catch(e) { top.error=e.message; }
    let activeStrategy = null;
    try { activeStrategy = d.prepare("SELECT * FROM strategies WHERE enabled=1 LIMIT 1").get(); } catch(e) {}
    const avgPct = totalTrades>0 ? (totalPnL/totalTrades*100).toFixed(2) : 0;
    res.json({ openPositions, totalPositions:0, pnl:{totalSol:Number(totalPnL.toFixed(4)), wins, losses, totalTrades, avgPct:Number(avgPct)}, signalEvents, totalCandidates, totalDecisions, settings:top, activeStrategy });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/positions', (req, res) => {
  try {
    const d = getDb();
    const rows = d.prepare("SELECT * FROM dry_run_positions WHERE status='open' ORDER BY opened_at_ms DESC LIMIT 50").all();
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/positions/all', (req, res) => {
  try {
    const d = getDb();
    const rows = d.prepare("SELECT * FROM dry_run_positions ORDER BY opened_at_ms DESC LIMIT 200").all();
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/position-trades', (req, res) => {
  try {
    const d = getDb();
    const limit = Math.min(parseInt(req.query.limit)||200, 1000);
    const rows = d.prepare("SELECT * FROM dry_run_trades ORDER BY at_ms DESC LIMIT ?").all(limit);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/candidates', (req, res) => {
  try {
    const d = getDb();
    const limit = Math.min(parseInt(req.query.limit)||500, 2000);
    const rows = d.prepare("SELECT * FROM candidates ORDER BY created_at_ms DESC LIMIT ?").all(limit);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/decisions', (req, res) => {
  try {
    const d = getDb();
    const limit = Math.min(parseInt(req.query.limit)||500, 2000);
    const rows = d.prepare("SELECT * FROM llm_decisions ORDER BY created_at_ms DESC LIMIT ?").all(limit);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/batches', (req, res) => {
  try {
    const d = getDb();
    const limit = Math.min(parseInt(req.query.limit)||50, 500);
    const rows = d.prepare("SELECT * FROM llm_batches ORDER BY created_at_ms DESC LIMIT ?").all(limit);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/decision-logs', (req, res) => {
  try {
    const d = getDb();
    const limit = Math.min(parseInt(req.query.limit)||100, 1000);
    const rows = d.prepare("SELECT * FROM decision_logs ORDER BY sent_at_ms DESC LIMIT ?").all(limit);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/strategies', (req, res) => {
  try {
    const d = getDb();
    const rows = d.prepare("SELECT * FROM strategies").all();
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/settings', (req, res) => {
  try {
    const d = getDb();
    const rows = d.prepare("SELECT key, value FROM settings ORDER BY key").all();
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/signals', (req, res) => {
  try {
    const d = getDb();
    const limit = Math.min(parseInt(req.query.limit)||100, 1000);
    const rows = d.prepare("SELECT * FROM signal_events ORDER BY at_ms DESC LIMIT ?").all(limit);
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/wallets', (req, res) => {
  try {
    const d = getDb();
    const rows = d.prepare("SELECT * FROM saved_wallets").all();
    res.json(rows);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.listen(PORT, '0.0.0.0', () => console.log('Dashboard running on port', PORT));

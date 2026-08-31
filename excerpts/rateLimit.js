// Trecho extraído do BarFlow Cloud (src/auth/rateLimit.js) — imports relativos ao
// repositório completo, privado. Ver README do showcase pro contexto.
const db = require('../db');
const config = require('../config');

// Cache em memória para resposta instantânea + sincronização com Postgres
const memoryLimits = new Map();

async function checkRateLimit(ip) {
  const now = Date.now();
  
  // 1. Checa memória primeiro (caminho rápido)
  const cached = memoryLimits.get(ip);
  if (cached && cached.lockedUntil && now < cached.lockedUntil) {
    const remainingMin = Math.ceil((cached.lockedUntil - now) / 60000);
    return { blocked: true, remainingMin };
  }

  // 2. Checa banco se não estiver em memória
  try {
    const res = await db.query(
      'SELECT count, locked_until FROM tentativas_login WHERE ip = $1',
      [ip]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      const lockedUntil = row.locked_until ? Number(row.locked_until) : null;
      if (lockedUntil && now < lockedUntil) {
        memoryLimits.set(ip, { count: row.count, lockedUntil });
        const remainingMin = Math.ceil((lockedUntil - now) / 60000);
        return { blocked: true, remainingMin };
      }
      memoryLimits.set(ip, { count: row.count, lockedUntil: null });
    }
  } catch (e) {
    console.warn('[RateLimit] Falha ao consultar banco, usando memória:', e.message);
  }

  return { blocked: false };
}

async function recordFailedAttempt(ip) {
  const now = Date.now();
  const current = memoryLimits.get(ip) || { count: 0, lockedUntil: null };
  current.count++;

  let lockedUntil = null;
  if (current.count >= config.maxLoginAttempts) {
    lockedUntil = now + config.lockoutMs;
    current.lockedUntil = lockedUntil;
    console.warn(`[Auth] IP ${ip} bloqueado por 15 min após ${config.maxLoginAttempts} falhas.`);
  }
  memoryLimits.set(ip, current);

  try {
    await db.query(`
      INSERT INTO tentativas_login (ip, count, locked_until, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (ip) DO UPDATE
      SET count = $2, locked_until = $3, updated_at = NOW()
    `, [ip, current.count, lockedUntil]);
  } catch (e) {
    console.warn('[RateLimit] Falha ao persistir falha no banco:', e.message);
  }

  return { blocked: !!lockedUntil, count: current.count };
}

async function resetAttempts(ip) {
  memoryLimits.delete(ip);
  try {
    await db.query('DELETE FROM tentativas_login WHERE ip = $1', [ip]);
  } catch (e) {
    console.warn('[RateLimit] Falha ao resetar tentativas no banco:', e.message);
  }
}

module.exports = {
  checkRateLimit,
  recordFailedAttempt,
  resetAttempts,
};

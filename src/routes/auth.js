// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/db');
const { JWT_SECRET } = require('../config/env');
const auth    = require('../middleware/auth');
const { getBalance, getAccountByUserId } = require('../services/balance');

const router = express.Router();

// ── POST /api/v1/auth/login ───────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: { code: 'MISSING_FIELDS', message: 'Email y contraseña son requeridos' }
      });
    }

    // Buscar usuario por email
    const { rows } = await db.query(
      'SELECT id, email, password_hash, nombre, rol, activo, skin, border, title FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Email o contraseña incorrectos' }
      });
    }

    const user = rows[0];

    if (!user.activo) {
      return res.status(401).json({
        ok: false,
        error: { code: 'ACCOUNT_INACTIVE', message: 'Tu cuenta está desactivada. Contactá al administrador.' }
      });
    }

    // Verificar contraseña
    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({
        ok: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Email o contraseña incorrectos' }
      });
    }

    // Obtener account_id del usuario
    const accResult = await db.query(
      'SELECT id FROM accounts WHERE user_id = $1 AND is_active = true LIMIT 1',
      [user.id]
    );
    const accountId = accResult.rows[0]?.id || null;

    // Generar token JWT (dura 24 horas)
    const token = jwt.sign(
      { sub: user.id, rol: user.rol, account_id: accountId },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      ok: true,
      data: {
        token,
        user: {
          id:     user.id,
          nombre: user.nombre,
          email:  user.email,
          rol:    user.rol,
          skin:   user.skin,
          border: user.border,
          title:  user.title,
          account_id: accountId,
        }
      }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error interno' } });
  }
});

// ── GET /api/v1/auth/me ───────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, nombre, apodo, alias, rol, skin, border, title,
              unlocked_skins, unlocked_borders, unlocked_titles, total_earned, estado, active_titles
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const user = rows[0];
    let balance = 0;

    if (req.user.account_id) {
      balance = await getBalance(req.user.account_id);
    }

    res.json({
      ok: true,
      data: { ...user, balance }
    });
  } catch (err) {
    console.error('Error en /me:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error interno' } });
  }
});

// ── POST /api/v1/auth/logout ──────────────────────────────────
// JWT es stateless — el logout real ocurre en el cliente borrando el token.
// Este endpoint existe para que el frontend tenga un punto de llamada consistente.
router.post('/logout', auth, (req, res) => {
  res.json({ ok: true, data: { message: 'Sesión cerrada correctamente' } });
});

module.exports = router;

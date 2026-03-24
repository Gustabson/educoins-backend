// src/services/audit.js
// Registra toda acción importante en el audit_log.
// Este log es de solo escritura — nadie puede modificarlo.

const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * Registra una acción en el audit_log.
 * @param {object} params
 * @param {string} params.actorId       - ID del usuario que realiza la acción
 * @param {string} params.action        - nombre de la acción (ej: 'approve_mission')
 * @param {string} [params.targetType]  - tipo del objeto afectado (ej: 'user', 'transaction')
 * @param {string} [params.targetId]    - ID del objeto afectado
 * @param {object} [params.details]     - datos extra en formato JSON
 * @param {object} [client]             - cliente de BD para usar dentro de una transacción
 */
async function log({ actorId, action, targetType, targetId, details }, client) {
  const executor = client || db;
  await executor.query(
    `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), actorId, action, targetType || null, targetId || null, JSON.stringify(details || {})]
  );
}

module.exports = { log };

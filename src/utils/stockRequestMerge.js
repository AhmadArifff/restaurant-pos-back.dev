const splitNote = (value) => String(value || '')
  .split(';')
  .map((item) => item.trim())
  .filter(Boolean);

const mergeNotes = (...values) => {
  const seen = new Set();
  const parts = [];

  for (const value of values) {
    for (const note of splitNote(value)) {
      const key = note.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(note);
    }
  }

  return parts.join('; ') || null;
};

const normalizeRequestItems = (items) => {
  const grouped = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    const stockItemId = Number(item.stock_item_id);
    const qty = Number(item.qty ?? item.qty_requested ?? 0);
    if (!stockItemId || !Number.isFinite(qty) || qty <= 0) continue;
    grouped.set(stockItemId, (grouped.get(stockItemId) || 0) + qty);
  }

  return [...grouped.entries()].map(([stock_item_id, qty]) => ({ stock_item_id, qty }));
};

const appendRequestItems = async (conn, requestId, items) => {
  const normalizedItems = normalizeRequestItems(items);

  for (const item of normalizedItems) {
    const [[si]] = await conn.query(
      'SELECT price_per_unit FROM stock_items WHERE id = ?',
      [item.stock_item_id]
    );

    const [[existing]] = await conn.query(
      'SELECT id, qty_requested FROM stock_request_items WHERE request_id = ? AND stock_item_id = ?',
      [requestId, item.stock_item_id]
    );

    if (existing) {
      await conn.query(
        'UPDATE stock_request_items SET qty_requested = ?, cost_per_unit = ? WHERE id = ?',
        [
          Number(existing.qty_requested || 0) + Number(item.qty),
          si?.price_per_unit || 0,
          existing.id,
        ]
      );
      continue;
    }

    await conn.query(`
      INSERT INTO stock_request_items
        (request_id, stock_item_id, qty_requested, cost_per_unit)
      VALUES (?, ?, ?, ?)
    `, [requestId, item.stock_item_id, item.qty, si?.price_per_unit || 0]);
  }

  return normalizedItems.length;
};

module.exports = {
  appendRequestItems,
  mergeNotes,
  normalizeRequestItems,
};

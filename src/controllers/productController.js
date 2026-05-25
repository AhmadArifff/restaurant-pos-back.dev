const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');
const {
  isSupabaseStorageEnabled,
  uploadImageBuffer,
  deleteByPublicUrl,
} = require('../services/supabaseStorage');

const USED_STOCK_BY_OWNER_SQL = `
  SELECT COALESCE(SUM(ti.qty * pi.qty), 0) AS total
  FROM transaction_items ti
  JOIN transactions t ON ti.transaction_id = t.id
  JOIN product_ingredients pi
    ON pi.product_id = ti.product_id
    AND pi.stock_item_id = ?
  WHERE COALESCE(t.source_user_id, t.created_by) = ?
`;

const deleteProductImage = async (imageUrl) => {
  if (!imageUrl) return;

  if (/^https?:\/\//i.test(imageUrl)) {
    await deleteByPublicUrl(imageUrl);
    return;
  }

  const oldPath = path.join(process.cwd(), 'public', imageUrl);
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
};

const getUploadedProductImageUrl = async (file) => {
  if (!file) return null;

  if (isSupabaseStorageEnabled()) {
    const uploaded = await uploadImageBuffer({
      folder: 'products',
      prefix: 'product',
      file,
    });
    return uploaded.publicUrl;
  }

  return `/images/products/${file.filename}`;
};

exports.getAll = async (req, res) => {
  try {
    const { category_id, search } = req.query;
    let sql = `
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (category_id) { sql += ' AND p.category_id = ?'; params.push(category_id); }
    if (search)       { sql += ' AND p.name LIKE ?';    params.push(`%${search}%`); }
    sql += ' ORDER BY p.name ASC';

    const [products] = await db.query(sql, params);

    // Ambil ingredients tiap produk sekaligus
    for (const p of products) {
      const [ings] = await db.query(`
        SELECT pi.qty, si.id AS stock_item_id, si.name AS ingredient_name, si.unit, si.stock
        FROM product_ingredients pi
        JOIN stock_items si ON pi.stock_item_id = si.id
        WHERE pi.product_id = ?
      `, [p.id]);
      p.ingredients = ings;

      // Hitung stok produk dari approved request saja.
      // Catatan: stok kasir/user tidak boleh dicampur dengan stok gudang umum.
      if (ings.length > 0) {
        let minStock = Infinity;

        for (const ing of ings) {
          // Total approved dari semua user
          const [[approvedResult]] = await db.query(`
            SELECT COALESCE(SUM(sri.qty_approved), 0) AS total_approved
            FROM stock_requests sr
            JOIN stock_request_items sri ON sri.request_id = sr.id
            WHERE sr.status = 'approved'
              AND sri.stock_item_id = ?
              AND sri.qty_approved IS NOT NULL
          `, [ing.stock_item_id]);

          // Total yang sudah dipakai di semua transaksi
          const [[usedResult]] = await db.query(`
            SELECT COALESCE(SUM(ti.qty * pi.qty), 0) AS total_used
            FROM transaction_items ti
            JOIN product_ingredients pi ON pi.product_id = ti.product_id
              AND pi.stock_item_id = ?
          `, [ing.stock_item_id]);

          const approvedStock = Math.max(0, Number(approvedResult.total_approved) - Number(usedResult.total_used));
          const portionsCanMake = Math.floor(approvedStock / ing.qty);
          minStock = Math.min(minStock, portionsCanMake);
        }

        p.stock = minStock === Infinity ? 0 : minStock;
      } else {
        p.stock = 0;
      }
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { name, price, category_id, ingredients } = req.body;
    const image_url = await getUploadedProductImageUrl(req.file);

    if (!name || !price)
      return res.status(400).json({ message: 'Nama dan harga wajib diisi' });

    const [result] = await db.query(
      'INSERT INTO products (name, price, category_id, image_url) VALUES (?, ?, ?, ?)',
      [name, price, category_id || null, image_url]
    );
    const productId = result.insertId;

    // Simpan ingredients/resep
    if (ingredients && ingredients.length) {
      const parsedIngs = typeof ingredients === 'string'
        ? JSON.parse(ingredients) : ingredients;

      for (const ing of parsedIngs) {
        await db.query(
          'INSERT INTO product_ingredients (product_id, stock_item_id, qty) VALUES (?, ?, ?)',
          [productId, ing.stock_item_id, ing.qty]
        );
      }
    }

    res.status(201).json({ message: 'Produk berhasil ditambahkan', id: productId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { name, price, category_id, ingredients } = req.body;
    const { id } = req.params;

    // Ambil data lama untuk hapus gambar lama jika ada gambar baru
    const [old] = await db.query('SELECT image_url FROM products WHERE id = ?', [id]);
    let image_url = old[0]?.image_url;

    if (req.file) {
      await deleteProductImage(image_url);
      image_url = await getUploadedProductImageUrl(req.file);
    }

    await db.query(
      'UPDATE products SET name=?, price=?, category_id=?, image_url=? WHERE id=?',
      [name, price, category_id || null, image_url, id]
    );

    // Update ingredients — hapus lama, insert baru
    if (ingredients !== undefined) {
      const parsedIngs = typeof ingredients === 'string'
        ? JSON.parse(ingredients) : ingredients;

      await db.query('DELETE FROM product_ingredients WHERE product_id = ?', [id]);
      for (const ing of parsedIngs) {
        await db.query(
          'INSERT INTO product_ingredients (product_id, stock_item_id, qty) VALUES (?, ?, ?)',
          [id, ing.stock_item_id, ing.qty]
        );
      }
    }

    res.json({ message: 'Produk berhasil diupdate' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const [old] = await db.query('SELECT image_url FROM products WHERE id = ?', [req.params.id]);
    if (old[0]?.image_url) {
      await deleteProductImage(old[0].image_url);
    }
    const [result] = await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (!result.affectedRows)
      return res.status(404).json({ message: 'Produk tidak ditemukan' });
    res.json({ message: 'Produk berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
// Endpoint baru: GET /products/my-stock (untuk kasir)
exports.getMyStock = async (req, res) => {
  try {
    const userId = req.user.id;

    const [products] = await db.query(`
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.name ASC
    `);

    for (const p of products) {
      // Ambil ingredients produk
      const [ings] = await db.query(`
        SELECT pi.qty, si.id AS stock_item_id, si.name AS ingredient_name, si.unit, si.stock
        FROM product_ingredients pi
        JOIN stock_items si ON pi.stock_item_id = si.id
        WHERE pi.product_id = ?
      `, [p.id]);
      p.ingredients = ings;

      if (ings.length === 0) {
        p.stock = 0;
        p.stock_per_kasir = {};
        continue;
      }

      // Hitung stok milik kasir ini dari approved requests SAJA (bukan warehouse)
      // Stok kasir = total qty approved - total qty yang sudah dipakai transaksi
      const stockPerItem = {};

      for (const ing of ings) {
        // Total approved untuk kasir ini SAJA
        const [[approved]] = await db.query(`
          SELECT COALESCE(SUM(sri.qty_approved), 0) AS total_approved
          FROM stock_requests sr
          JOIN stock_request_items sri ON sri.request_id = sr.id
          WHERE sr.user_id = ?
            AND sr.status = 'approved'
            AND sri.stock_item_id = ?
            AND sri.qty_approved IS NOT NULL
        `, [userId, ing.stock_item_id]);

        // Total sudah dipakai di transaksi kasir ini
        // USED_STOCK_BY_OWNER_SQL returns column alias 'total' (COALESCE(SUM(...)) AS total)
        const [[used]] = await db.query(USED_STOCK_BY_OWNER_SQL, [ing.stock_item_id, userId]);

        // Stok = approved - used (TIDAK termasuk warehouse stock)
        // BUG FIX: changed from used.total_used to used.total to match SQL alias
        const approvedStock = Math.max(0, Number(approved.total_approved) - Number(used.total));
        stockPerItem[ing.stock_item_id] = approvedStock;
      }

      // Stok produk = min dari semua bahan / qty per produk
      p.stock = Math.min(
        ...ings.map(ing => {
          const available = stockPerItem[ing.stock_item_id] || 0;
          return Math.floor(available / ing.qty);
        })
      );
      p.stock_per_kasir = stockPerItem;
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
exports.getStockByKasir = async (req, res) => {
  try {
    const [kasirs] = await db.query(
      `SELECT id, name FROM users WHERE role = 'kasir' ORDER BY name ASC`
    );

    const [products] = await db.query(
      `SELECT p.id FROM products p ORDER BY p.name ASC`
    );

    const result = {};

    for (const p of products) {
      const [ings] = await db.query(`
        SELECT pi.qty, pi.stock_item_id
        FROM product_ingredients pi
        WHERE pi.product_id = ?
      `, [p.id]);

      if (ings.length === 0) {
        result[p.id] = [];
        continue;
      }

      const kasirStocks = [];

      for (const kasir of kasirs) {
        let canMake = Infinity;

        for (const ing of ings) {
          const [[approved]] = await db.query(`
            SELECT COALESCE(SUM(sri.qty_approved), 0) AS total
            FROM stock_requests sr
            JOIN stock_request_items sri ON sri.request_id = sr.id
            WHERE sr.user_id = ? AND sr.status = 'approved'
              AND sri.stock_item_id = ? AND sri.qty_approved IS NOT NULL
          `, [kasir.id, ing.stock_item_id]);

          const [[used]] = await db.query(USED_STOCK_BY_OWNER_SQL, [ing.stock_item_id, kasir.id]);

          const remaining = Math.max(0, Number(approved.total) - Number(used.total));
          canMake = Math.min(canMake, Math.floor(remaining / ing.qty));
        }

        kasirStocks.push({
          kasir_id: kasir.id,
          kasir_name: kasir.name,
          can_make: canMake === Infinity ? 0 : canMake,
        });
      }

      result[p.id] = kasirStocks;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
// GET /products/stock-all — admin lihat stok semua user per produk
exports.getStockAllUsers = async (req, res) => {
  try {
    // Ambil semua user (kasir + admin)
    const [users] = await db.query(
      `SELECT id, name, role FROM users ORDER BY role DESC, name ASC`
    );

    const [products] = await db.query(`
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.name ASC
    `);

    for (const p of products) {
      const [ings] = await db.query(`
        SELECT pi.qty, si.id AS stock_item_id, si.name AS ingredient_name, si.unit, si.stock
        FROM product_ingredients pi
        JOIN stock_items si ON pi.stock_item_id = si.id
        WHERE pi.product_id = ?
      `, [p.id]);
      p.ingredients = ings;

      const stockByUser = [];

      for (const u of users) {
        if (ings.length === 0) {
          stockByUser.push({ user_id: u.id, user_name: u.name, role: u.role, can_make: 0 });
          continue;
        }

        let canMake = Infinity;
        const ingredientStocks = [];

        for (const ing of ings) {
          // Total approved untuk user ini (dari approved requests SAJA, bukan warehouse)
          const [[approved]] = await db.query(`
            SELECT COALESCE(SUM(sri.qty_approved), 0) AS total
            FROM stock_requests sr
            JOIN stock_request_items sri ON sri.request_id = sr.id
            WHERE sr.user_id = ? AND sr.status = 'approved'
              AND sri.stock_item_id = ?
              AND sri.qty_approved IS NOT NULL
          `, [u.id, ing.stock_item_id]);

          // Total sudah dipakai di transaksi user ini
          const [[used]] = await db.query(USED_STOCK_BY_OWNER_SQL, [ing.stock_item_id, u.id]);

          // Stok hanya dari approved requests (TIDAK termasuk warehouse stock)
          const approvedStock = Math.max(0, Number(approved.total) - Number(used.total));
          ingredientStocks.push({
            stock_item_id: ing.stock_item_id,
            ingredient_name: ing.ingredient_name,
            unit: ing.unit,
            qty_per_portion: Number(ing.qty),
            available_qty: approvedStock,
            can_make: Math.floor(approvedStock / Number(ing.qty || 1)),
          });
          canMake = Math.min(canMake, Math.floor(approvedStock / ing.qty));
        }

        stockByUser.push({
          user_id:   u.id,
          user_name: u.name,
          role:      u.role,
          can_make:  canMake === Infinity ? 0 : canMake,
          ingredients: ingredientStocks,
        });
      }

      p.stock_by_user = stockByUser;
      // Total stok dari semua user
      p.stock = stockByUser.reduce((s, u) => s + u.can_make, 0);
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

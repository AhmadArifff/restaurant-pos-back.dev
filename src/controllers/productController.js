const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');
const {
  isSupabaseStorageEnabled,
  uploadImageBuffer,
  deleteByPublicUrl,
} = require('../services/supabaseStorage');
const { getRequestBranchId } = require('../utils/branchContext');

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

const getBranchIngredientBalance = async (stockItemId, branchId) => {
  const [[balance]] = await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'in' THEN qty ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'out' THEN qty ELSE 0 END), 0) AS total
    FROM main_stock
    WHERE stock_item_id = ?
      AND (? IS NULL OR branch_id = ?)
  `, [stockItemId, branchId, branchId]);

  return Math.max(0, Number(balance?.total || 0));
};

const calculateProductStockByBranch = async (ingredients, branchId) => {
  if (!ingredients.length) return { stock: 0, ingredientBalances: {} };

  let minStock = Infinity;
  const ingredientBalances = {};

  for (const ing of ingredients) {
    const balance = await getBranchIngredientBalance(ing.stock_item_id, branchId);
    ingredientBalances[ing.stock_item_id] = balance;
    minStock = Math.min(minStock, Math.floor(balance / Number(ing.qty || 1)));
  }

  return {
    stock: minStock === Infinity ? 0 : minStock,
    ingredientBalances,
  };
};

exports.getAll = async (req, res) => {
  try {
    const { category_id, search } = req.query;
    const branchId = getRequestBranchId(req) || req.user?.branch_id || null;
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

      const { stock, ingredientBalances } = await calculateProductStockByBranch(ings, branchId);
      p.stock = stock;
      p.branch_stock = ingredientBalances;
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
    const branchId = getRequestBranchId(req) || req.user?.branch_id || null;

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

      const stockPerItem = {};

      for (const ing of ings) {
        stockPerItem[ing.stock_item_id] = await getBranchIngredientBalance(ing.stock_item_id, branchId);
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
    const branchId = getRequestBranchId(req) || req.user?.branch_id || null;
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
          const remaining = await getBranchIngredientBalance(ing.stock_item_id, branchId);
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
    const branchId = getRequestBranchId(req) || req.user?.branch_id || null;
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
          const approvedStock = await getBranchIngredientBalance(ing.stock_item_id, branchId);
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
      p.stock = stockByUser[0]?.can_make || 0;
    }

    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');
const {
  isSupabaseStorageEnabled,
  uploadImageBuffer,
  deleteByPublicUrl,
} = require('../services/supabaseStorage');
const {
  getBranchIngredientBalances,
  getUserIngredientBalances,
} = require('../services/stockAllocationService');
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

const toProductIds = (products) => products.map((product) => Number(product.id)).filter(Boolean);
const toStockItemIds = (ingredientsByProductId) => [
  ...new Set(Object.values(ingredientsByProductId)
    .flat()
    .map((ingredient) => Number(ingredient.stock_item_id))
    .filter(Boolean)),
];

const groupByProductId = (rows) => rows.reduce((acc, row) => {
  const productId = Number(row.product_id);
  if (!acc[productId]) acc[productId] = [];
  acc[productId].push(row);
  return acc;
}, {});

const fetchIngredientsByProductIds = async (productIds, includeStockItem = true) => {
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};

  const placeholders = ids.map(() => '?').join(',');
  const selectStock = includeStockItem
    ? ', si.name AS ingredient_name, si.unit, si.stock'
    : '';
  const joinStock = includeStockItem
    ? 'JOIN stock_items si ON pi.stock_item_id = si.id'
    : '';

  const [rows] = await db.query(`
    SELECT pi.product_id, pi.qty, pi.stock_item_id${selectStock}
    FROM product_ingredients pi
    ${joinStock}
    WHERE pi.product_id IN (${placeholders})
    ORDER BY pi.product_id ASC, pi.id ASC
  `, ids);

  return groupByProductId(rows);
};

const calculateCanMake = (ingredients, balances) => {
  if (!ingredients.length) return 0;
  return Math.min(...ingredients.map((ingredient) => {
    const available = balances[Number(ingredient.stock_item_id)] || 0;
    return Math.floor(available / Number(ingredient.qty || 1));
  }));
};

const parseIngredients = (ingredients) => {
  if (!ingredients) return [];
  return typeof ingredients === 'string' ? JSON.parse(ingredients) : ingredients;
};

const insertProductIngredients = async (executor, productId, ingredients) => {
  const parsedIngs = parseIngredients(ingredients)
    .map((ing) => ({
      stock_item_id: Number(ing.stock_item_id),
      qty: Number(ing.qty),
    }))
    .filter((ing) => ing.stock_item_id && Number.isFinite(ing.qty) && ing.qty > 0);

  if (!parsedIngs.length) return;

  const values = parsedIngs.map(() => '(?, ?, ?)').join(',');
  const params = parsedIngs.flatMap((ing) => [productId, ing.stock_item_id, ing.qty]);
  await executor.query(`
    INSERT INTO product_ingredients (product_id, stock_item_id, qty)
    VALUES ${values}
  `, params);
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
    const ingredientsByProductId = await fetchIngredientsByProductIds(toProductIds(products));
    const branchBalances = await getBranchIngredientBalances(
      db,
      toStockItemIds(ingredientsByProductId),
      branchId
    );

    for (const p of products) {
      const ingredients = ingredientsByProductId[Number(p.id)] || [];
      p.ingredients = ingredients;
      p.stock = calculateCanMake(ingredients, branchBalances);
      p.branch_stock = ingredients.reduce((acc, ingredient) => {
        acc[ingredient.stock_item_id] = branchBalances[Number(ingredient.stock_item_id)] || 0;
        return acc;
      }, {});
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

    await insertProductIngredients(db, productId, ingredients);

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
      await db.query('DELETE FROM product_ingredients WHERE product_id = ?', [id]);
      await insertProductIngredients(db, id, ingredients);
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
    const ingredientsByProductId = await fetchIngredientsByProductIds(toProductIds(products));
    const userBalances = await getUserIngredientBalances(
      db,
      toStockItemIds(ingredientsByProductId),
      [req.user.id],
      branchId
    );
    const stockPerItem = userBalances[Number(req.user.id)] || {};

    for (const p of products) {
      const ingredients = ingredientsByProductId[Number(p.id)] || [];
      p.ingredients = ingredients;
      p.stock = calculateCanMake(ingredients, stockPerItem);
      p.stock_per_kasir = ingredients.reduce((acc, ingredient) => {
        acc[ingredient.stock_item_id] = stockPerItem[Number(ingredient.stock_item_id)] || 0;
        return acc;
      }, {});
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
    const ingredientsByProductId = await fetchIngredientsByProductIds(toProductIds(products), false);
    const userBalances = await getUserIngredientBalances(
      db,
      toStockItemIds(ingredientsByProductId),
      kasirs.map((kasir) => kasir.id),
      branchId
    );

    const result = {};

    for (const p of products) {
      const ings = ingredientsByProductId[Number(p.id)] || [];

      if (ings.length === 0) {
        result[p.id] = [];
        continue;
      }

      const kasirStocks = [];

      for (const kasir of kasirs) {
        const canMake = calculateCanMake(ings, userBalances[Number(kasir.id)] || {});

        kasirStocks.push({
          kasir_id: kasir.id,
          kasir_name: kasir.name,
          can_make: canMake,
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
    const ingredientsByProductId = await fetchIngredientsByProductIds(toProductIds(products));
    const userBalances = await getUserIngredientBalances(
      db,
      toStockItemIds(ingredientsByProductId),
      users.map((user) => user.id),
      branchId
    );

    for (const p of products) {
      const ings = ingredientsByProductId[Number(p.id)] || [];
      p.ingredients = ings;

      const stockByUser = [];

      for (const u of users) {
        if (ings.length === 0) {
          stockByUser.push({ user_id: u.id, user_name: u.name, role: u.role, can_make: 0 });
          continue;
        }

        let canMake = Infinity;
        const ingredientStocks = [];
        const balances = userBalances[Number(u.id)] || {};

        for (const ing of ings) {
          const approvedStock = balances[Number(ing.stock_item_id)] || 0;
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

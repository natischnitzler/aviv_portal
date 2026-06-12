const express = require('express');
const xmlrpc  = require('xmlrpc');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIGURACIÓN ODOO AVIV ──────────────────────────────────────
const ODOO_URL  = 'https://aviv.odoo.com';
const ODOO_DB   = process.env.ODOO_DB   || '';
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASS = process.env.ODOO_PASSWORD || '';

// ── CLIENTES DESDE CSV ───────────────────────────────────────────
function loadClientes() {
  const file = path.join(__dirname, '..', 'clientes.csv');
  if (!fs.existsSync(file)) { console.warn('⚠ No se encontró clientes.csv'); return {}; }

  const rawContent = fs.readFileSync(file, 'utf8');
  const firstLine  = rawContent.split(/\r?\n/)[0];
  const sep        = firstLine.includes(';') ? ';' : ',';

  function parseCSVLine(line) {
    const fields = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"')              { inQ = !inQ; }
      else if (c === sep && !inQ) { fields.push(cur.trim()); cur = ''; }
      else                        { cur += c; }
    }
    fields.push(cur.trim());
    return fields;
  }

  const lines  = rawContent.split(/\r?\n/).filter(Boolean);
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const p = parseCSVLine(lines[i]);
    if (p.length < 3) continue;
    const codigo    = (p[0]||'').trim().toUpperCase();
    const nombre    = (p[1]||'').trim();
    const partnerId = parseInt(p[2]||'0', 10);
    const sucRaw    = (p[3]||'').replace(/^"|"$/g,'').trim();
    const sucursales = sucRaw ? sucRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
    if (codigo && partnerId) {
      result[codigo] = { partnerId, name: nombre, sucursales };
    }
  }
  console.log('✅ Clientes cargados:', Object.keys(result).join(', '));
  return result;
}

const CLIENTES = loadClientes();
function getCliente(code) { return CLIENTES[(code||'').toUpperCase()] || null; }

// ── AUTH ODOO CON CACHÉ ──────────────────────────────────────────
let cachedUID    = null;
let lastAuthTime = 0;
const AUTH_TTL   = 3600000;

async function getUID() {
  if (cachedUID && (Date.now() - lastAuthTime) < AUTH_TTL) return cachedUID;
  const client = xmlrpc.createSecureClient({
    host: new URL(ODOO_URL).hostname, port: 443, path: '/xmlrpc/2/common'
  });
  return new Promise((resolve, reject) => {
    client.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_PASS, {}], (err, uid) => {
      if (err) return reject(err);
      cachedUID = uid; lastAuthTime = Date.now();
      console.log('✅ UID Odoo Aviv:', uid);
      resolve(uid);
    });
  });
}

function xmlrpcCall(model, method, args) {
  return getUID().then(uid => {
    const client = xmlrpc.createSecureClient({
      host: new URL(ODOO_URL).hostname, port: 443, path: '/xmlrpc/2/object'
    });
    return new Promise((resolve, reject) => {
      client.methodCall('execute_kw', [ODOO_DB, uid, ODOO_PASS, model, method, args],
        (err, result) => err ? reject(err) : resolve(result)
      );
    });
  });
}

// ── MIDDLEWARE auth ──────────────────────────────────────────────
function requireClient(req, res, next) {
  const code    = (req.headers['x-client-code'] || '').toUpperCase();
  const cliente = getCliente(code);
  if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });
  req.partnerId  = cliente.partnerId;
  req.clientName = cliente.name;
  next();
}

// ── CACHÉ EN MEMORIA ─────────────────────────────────────────────
const cache = {};
const CACHE_TTL = {
  productos: 30 * 60 * 1000,  // 30 min
  stock:     15 * 60 * 1000,  // 15 min
  pricelist:  60 * 60 * 1000, // 60 min
};
function cacheGet(key) {
  const e = cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { delete cache[key]; return null; }
  return e.data;
}
function cacheSet(key, data, ttl) { cache[key] = { data, ts: Date.now(), ttl }; }

// ── OBTENER PRICELIST DEL CLIENTE ────────────────────────────────
async function getPricelistId(partnerId) {
  const cached = cacheGet('pricelist_' + partnerId);
  if (cached !== null) return cached;

  const partners = await xmlrpcCall('res.partner', 'read', [
    [partnerId], ['property_product_pricelist']
  ]);
  const pl = partners[0]?.property_product_pricelist;
  const plId = Array.isArray(pl) ? pl[0] : null;
  cacheSet('pricelist_' + partnerId, plId, CACHE_TTL.pricelist);
  return plId;
}

// ════════════════════════════════════════════════════════════════
// MÓDULO 1 — BIBLIOTECA DE PRODUCTOS
// ════════════════════════════════════════════════════════════════
app.get('/api/productos', async (req, res) => {
  try {
    const code    = (req.headers['x-client-code'] || '').toUpperCase();
    const cliente = getCliente(code);
    if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });

    const cached = cacheGet('productos');
    if (cached) return res.json(cached);

    const prodIds = await xmlrpcCall('product.template', 'search', [[
      ['sale_ok', '=', true],
      ['active',  '=', true]
    ]]);
    if (!prodIds.length) return res.json([]);

    const productos = await xmlrpcCall('product.template', 'read', [
      prodIds,
      ['id','name','default_code','description_sale','list_price',
       'categ_id','uom_id','image_128','barcode']
    ]);

    const result = productos.map(p => ({
      id:          p.id,
      sku:         p.default_code || '',
      nombre:      p.name         || '',
      descripcion: p.description_sale || '',
      precio:      parseFloat(p.list_price || 0),
      categoria:   Array.isArray(p.categ_id) ? p.categ_id[1] : '',
      unidad:      Array.isArray(p.uom_id)   ? p.uom_id[1]   : '',
      imagen:      p.image_128 ? 'data:image/png;base64,' + p.image_128 : null,
      barcode:     p.barcode || ''
    }));

    cacheSet('productos', result, CACHE_TTL.productos);
    res.json(result);
  } catch(e) {
    console.error('❌ /api/productos', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/productos/cache', (req, res) => {
  Object.keys(cache).filter(k => k.startsWith('productos')).forEach(k => delete cache[k]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// MÓDULO 2 — STOCK + PRECIOS POR PRICELIST DEL CLIENTE
// ════════════════════════════════════════════════════════════════
app.get('/api/stock', async (req, res) => {
  try {
    const code    = (req.headers['x-client-code'] || '').toUpperCase();
    const cliente = getCliente(code);
    if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });

    const cached = cacheGet('stock_' + code);
    if (cached) return res.json(cached);

    // 1. Traer stock de todos los productos
    const prodIds = await xmlrpcCall('product.product', 'search', [[
      ['sale_ok', '=', true],
      ['active',  '=', true]
    ]]);
    if (!prodIds.length) return res.json([]);

    const prods = await xmlrpcCall('product.product', 'read', [
      prodIds,
      ['id','default_code','name','qty_available','list_price','product_tmpl_id']
    ]);

    // 2. Obtener pricelist del cliente y calcular precios
    const plId = await getPricelistId(cliente.partnerId);
    let preciosMap = {};

    if (plId) {
      try {
        // Calcular precio con pricelist para cada producto
        const skus = prods.map(p => p.id);
        const precios = await xmlrpcCall('product.pricelist', 'get_products_price', [
          [plId], skus, skus.map(() => 1), new Date().toISOString().slice(0, 10)
        ]);
        preciosMap = precios || {};
      } catch(e) {
        console.warn('⚠ No se pudo obtener precios de pricelist:', e.message);
      }
    }

    const result = prods.map(p => ({
      id:    p.id,
      sku:   p.default_code || '',
      des:   p.name         || '',
      stock: parseFloat(p.qty_available || 0),
      precio: parseFloat(preciosMap[p.id] || p.list_price || 0)
    }));

    cacheSet('stock_' + code, result, CACHE_TTL.stock);
    res.json(result);
  } catch(e) {
    console.error('❌ /api/stock', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/stock/cache', (req, res) => {
  const code = (req.headers['x-client-code'] || '').toUpperCase();
  delete cache['stock_' + code];
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// MÓDULO 3 — INGRESO DE VENTAS
// ════════════════════════════════════════════════════════════════
app.post('/api/pedido', requireClient, async (req, res) => {
  try {
    const { productos, sucursal, nota } = req.body?.data || {};
    if (!productos?.length) return res.status(400).json({ error: 'Sin productos' });

    // Buscar IDs de productos por SKU
    const skus = productos.map(p => p.sku);
    const prodRecs = await xmlrpcCall('product.product', 'search_read', [[
      ['default_code', 'in', skus],
      ['active', '=', true]
    ], { fields: ['id','default_code'] }]);

    const skuToId = {};
    prodRecs.forEach(p => { skuToId[p.default_code] = p.id; });

    const orderLines = productos
      .filter(p => skuToId[p.sku])
      .map(p => [0, 0, {
        product_id: skuToId[p.sku],
        product_uom_qty: p.quantity,
        name: p.sku
      }]);

    if (!orderLines.length) return res.status(400).json({ error: 'Ningún SKU reconocido en Odoo' });

    const orderId = await xmlrpcCall('sale.order', 'create', [{
      partner_id:  req.partnerId,
      note:        [sucursal, nota].filter(Boolean).join(' | '),
      order_line:  orderLines
    }]);

    // Confirmar la orden
    await xmlrpcCall('sale.order', 'action_confirm', [[orderId]]);

    res.json({ ok: true, orderId, message: 'Pedido creado en Odoo' });
  } catch(e) {
    console.error('❌ /api/pedido', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Historial de ventas
app.get('/api/pedidos', requireClient, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');
    const ids = await xmlrpcCall('sale.order', 'search', [[
      ['partner_id', '=', req.partnerId],
      ['state', 'in', ['sale','done','cancel']]
    ], { order: 'date_order desc', limit }]);

    if (!ids.length) return res.json([]);

    const orders = await xmlrpcCall('sale.order', 'read', [
      ids,
      ['name','date_order','state','amount_total','amount_untaxed','note']
    ]);

    res.json(orders.map(o => ({
      id:    o.id,
      nombre: o.name,
      fecha:  o.date_order,
      estado: o.state,
      total:  parseFloat(o.amount_total   || 0),
      neto:   parseFloat(o.amount_untaxed || 0),
      nota:   o.note || ''
    })));
  } catch(e) {
    console.error('❌ /api/pedidos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PERFIL ───────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const code    = (req.headers['x-client-code'] || '').toUpperCase();
  const cliente = getCliente(code);
  if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });
  res.json({ name: cliente.name, partnerId: cliente.partnerId, sucursales: cliente.sucursales || [] });
});

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;

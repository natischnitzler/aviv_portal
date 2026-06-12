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
const ODOO_DB   = process.env.ODOO_DB   || '';   // nombre de la base de datos
const ODOO_USER = process.env.ODOO_USER || '';   // usuario admin
const ODOO_PASS = process.env.ODOO_PASSWORD || '';

// ── CLIENTES DESDE CSV ───────────────────────────────────────────
function loadClientes() {
  const file = path.join(__dirname, 'clientes.csv');
  if (!fs.existsSync(file)) { console.warn('⚠ No se encontró clientes.csv'); return {}; }

  const rawContent = fs.readFileSync(file, 'utf8');
  const firstLine  = rawContent.split(/\r?\n/)[0];
  const sep        = firstLine.includes(';') ? ';' : ',';

  function parseCSVLine(line) {
    const fields = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"')           { inQ = !inQ; }
      else if (c === sep && !inQ) { fields.push(cur.trim()); cur = ''; }
      else                     { cur += c; }
    }
    fields.push(cur.trim());
    return fields;
  }

  const lines  = rawContent.split(/\r?\n/).filter(Boolean);
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const p = parseCSVLine(lines[i]);
    if (p.length < 4) continue;
    const codigo    = (p[0]||'').trim().toUpperCase();
    const nombre    = (p[1]||'').trim();
    const partnerId = parseInt(p[2]||'0', 10);
    const apiKey    = (p[3]||'').trim();
    const sucRaw    = (p[4]||'').replace(/^"|"$/g,'').trim();
    const sucursales = sucRaw ? sucRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
    if (codigo && apiKey && partnerId) {
      result[codigo] = { apiKey, partnerId, name: nombre, sucursales };
    }
  }
  console.log('✅ Clientes cargados:', Object.keys(result).join(', '));
  return result;
}

const CLIENTES = loadClientes();

function getCliente(code) {
  return CLIENTES[(code||'').toUpperCase()] || null;
}

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

// ── PROXY ODOO REST con API key del cliente ──────────────────────
async function odooProxy(path, apiKey, options = {}) {
  const url  = ODOO_URL + path;
  const opts = {
    method:  options.method || 'GET',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json', ...(options.headers||{}) }
  };
  if (options.body) opts.body = JSON.stringify(options.body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── MIDDLEWARE auth ──────────────────────────────────────────────
function requireClient(req, res, next) {
  const code    = (req.headers['x-client-code'] || '').toUpperCase();
  const cliente = getCliente(code);
  if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });
  req.apiKey     = cliente.apiKey;
  req.partnerId  = cliente.partnerId;
  req.clientName = cliente.name;
  next();
}

// ── CACHÉ EN MEMORIA ─────────────────────────────────────────────
const cache = {};
const CACHE_TTL = {
  productos:  30 * 60 * 1000,  // 30 min  — catálogo no cambia seguido
  stock:      15 * 60 * 1000,  // 15 min
};
function cacheGet(key) {
  const e = cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { delete cache[key]; return null; }
  return e.data;
}
function cacheSet(key, data, ttl) { cache[key] = { data, ts: Date.now(), ttl }; }

// ════════════════════════════════════════════════════════════════
// MÓDULO 1 — BIBLIOTECA DE PRODUCTOS
// GET /api/productos  → lista de productos con imagen y ficha
// ════════════════════════════════════════════════════════════════
app.get('/api/productos', async (req, res) => {
  try {
    const code    = (req.headers['x-client-code'] || '').toUpperCase();
    const cliente = getCliente(code);
    if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });

    const cached = cacheGet('productos_' + code);
    if (cached) return res.json(cached);

    // Traer productos publicados con sus campos relevantes
    const prodIds = await xmlrpcCall('product.template', 'search', [[
      ['sale_ok', '=', true],
      ['active',  '=', true]
    ]]);

    if (!prodIds.length) return res.json([]);

    const productos = await xmlrpcCall('product.template', 'read', [
      prodIds,
      ['id', 'name', 'default_code', 'description_sale', 'list_price',
       'categ_id', 'uom_id', 'image_128', 'product_tag_ids', 'barcode']
    ]);

    // Limpiar y formatear
    const result = productos.map(p => ({
      id:          p.id,
      sku:         p.default_code || '',
      nombre:      p.name         || '',
      descripcion: p.description_sale || '',
      precio:      parseFloat(p.list_price || 0),
      categoria:   Array.isArray(p.categ_id)  ? p.categ_id[1]  : '',
      unidad:      Array.isArray(p.uom_id)    ? p.uom_id[1]    : '',
      imagen:      p.image_128 ? 'data:image/png;base64,' + p.image_128 : null,
      barcode:     p.barcode || ''
    }));

    cacheSet('productos_' + code, result, CACHE_TTL.productos);
    res.json(result);
  } catch(e) {
    console.error('❌ /api/productos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/productos/cache — forzar recarga
app.delete('/api/productos/cache', (req, res) => {
  const code = (req.headers['x-client-code'] || '').toUpperCase();
  Object.keys(cache).filter(k => k.startsWith('productos_')).forEach(k => delete cache[k]);
  console.log('🗑 Caché productos limpiado');
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// MÓDULO 2 — STOCK (para vitrina y pedidos)
// GET /api/stock  → productos con stock y precio personalizado del cliente
// ════════════════════════════════════════════════════════════════
app.get('/api/stock', async (req, res) => {
  try {
    const code    = (req.headers['x-client-code'] || '').toUpperCase();
    const cliente = getCliente(code);
    if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });

    const cached = cacheGet('stock_' + code);
    if (cached) return res.json(cached);

    // Usar API REST de Odoo con la API key del cliente (incluye precios personalizados)
    const r = await odooProxy('/api/stock', cliente.apiKey);
    if (!r.ok) return res.status(r.status).json({ error: 'Error Odoo stock', detail: r.data });

    cacheSet('stock_' + code, r.data, CACHE_TTL.stock);
    res.json(r.data);
  } catch(e) {
    console.error('❌ /api/stock', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/stock/cache', (req, res) => {
  const code = (req.headers['x-client-code'] || '').toUpperCase();
  delete cache['stock_' + code];
  res.json({ ok: true, message: 'Caché stock limpiado' });
});

// ════════════════════════════════════════════════════════════════
// MÓDULO 3 — INGRESO DE VENTAS
// POST /api/pedido        → crear venta nueva en Odoo
// POST /api/pedido-update → agregar productos a venta existente
// GET  /api/pedidos       → historial de ventas del cliente
// ════════════════════════════════════════════════════════════════

// Crear pedido nuevo
app.post('/api/pedido', requireClient, async (req, res) => {
  try {
    const r = await odooProxy('/sale/create', req.apiKey, {
      method: 'POST',
      body:   req.body
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Error Odoo pedido', detail: r.data });
    res.json(r.data);
  } catch(e) {
    console.error('❌ /api/pedido', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Agregar productos a venta existente
app.post('/api/pedido-update', requireClient, async (req, res) => {
  try {
    const idVenta = req.headers['idventa'];
    if (!idVenta) return res.status(400).json({ error: 'idventa requerido en header' });
    const r = await odooProxy('/sale/update', req.apiKey, {
      method: 'POST',
      headers: { 'idventa': idVenta },
      body:   req.body
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Error Odoo update', detail: r.data });
    res.json(r.data);
  } catch(e) {
    console.error('❌ /api/pedido-update', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Historial de ventas
app.get('/api/pedidos', requireClient, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');

    const ids = await xmlrpcCall('sale.order', 'search', [[
      ['partner_id', '=', req.partnerId],
      ['state',      'in', ['sale', 'done', 'cancel']]
    ], { order: 'date_order desc', limit }]);

    if (!ids.length) return res.json([]);

    const orders = await xmlrpcCall('sale.order', 'read', [
      ids,
      ['name', 'date_order', 'state', 'amount_total', 'amount_untaxed', 'note']
    ]);

    const result = orders.map(o => ({
      id:       o.id,
      nombre:   o.name,
      fecha:    o.date_order,
      estado:   o.state,
      total:    parseFloat(o.amount_total   || 0),
      neto:     parseFloat(o.amount_untaxed || 0),
      nota:     o.note || ''
    }));

    res.json(result);
  } catch(e) {
    console.error('❌ /api/pedidos', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PERFIL DEL CLIENTE ───────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const code    = (req.headers['x-client-code'] || '').toUpperCase();
  const cliente = getCliente(code);
  if (!cliente) return res.status(401).json({ error: 'Cliente no reconocido' });
  res.json({ name: cliente.name, partnerId: cliente.partnerId, sucursales: cliente.sucursales || [] });
});

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Aviv Portal API corriendo en puerto ${PORT}`));

const express  = require('express');
const xmlrpc   = require('xmlrpc');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');

const app = express();
app.use(cors());
app.use(express.json());

const ODOO_URL  = 'https://aviv.odoo.com';
const ODOO_DB   = process.env.ODOO_DB   || '';
const ODOO_USER = process.env.ODOO_USER || '';
const ODOO_PASS = process.env.ODOO_PASSWORD || '';

const CATEGORIAS_OK = ['Oro / Anillo', 'Plata / Anillo', 'Plata / Argolla'];

// ── CSV ──────────────────────────────────────────────────────────
function loadClientes() {
  const file = path.join(__dirname, '..', 'clientes.csv');
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const sep = raw.split(/\r?\n/)[0].includes(';') ? ';' : ',';
  function parseLine(line) {
    const f=[]; let cur='', inQ=false;
    for (const c of line) {
      if (c==='"') inQ=!inQ;
      else if (c===sep&&!inQ) { f.push(cur.trim()); cur=''; }
      else cur+=c;
    }
    f.push(cur.trim()); return f;
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const result = {};
  for (let i=1;i<lines.length;i++) {
    const p = parseLine(lines[i]);
    if (p.length<3) continue;
    const codigo       = (p[0]||'').trim().toUpperCase();
    const nombre       = (p[1]||'').trim();
    const partnerId    = parseInt(p[2]||'0',10);
    const multiplicador= parseFloat(p[3]||'3');
    const sucRaw       = (p[4]||'').replace(/^"|"$/g,'').trim();
    const sucursales   = sucRaw ? sucRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
    if (codigo && partnerId) result[codigo] = { partnerId, name:nombre, multiplicador, sucursales };
  }
  console.log('✅ Clientes:', Object.keys(result).join(', '));
  return result;
}
const CLIENTES = loadClientes();
function getCliente(code) { return CLIENTES[(code||'').toUpperCase()]||null; }

// ── ODOO AUTH ────────────────────────────────────────────────────
let cachedUID=null, lastAuthTime=0;
async function getUID() {
  if (cachedUID && (Date.now()-lastAuthTime)<3600000) return cachedUID;
  const client = xmlrpc.createSecureClient({host:new URL(ODOO_URL).hostname,port:443,path:'/xmlrpc/2/common'});
  return new Promise((resolve,reject)=>{
    client.methodCall('authenticate',[ODOO_DB,ODOO_USER,ODOO_PASS,{}],(err,uid)=>{
      if(err) return reject(err);
      cachedUID=uid; lastAuthTime=Date.now(); resolve(uid);
    });
  });
}
function xmlrpcCall(model,method,args) {
  return getUID().then(uid=>{
    const client=xmlrpc.createSecureClient({host:new URL(ODOO_URL).hostname,port:443,path:'/xmlrpc/2/object'});
    return new Promise((resolve,reject)=>{
      client.methodCall('execute_kw',[ODOO_DB,uid,ODOO_PASS,model,method,args],(err,r)=>err?reject(err):resolve(r));
    });
  });
}

// ── CACHÉ ────────────────────────────────────────────────────────
const cache={};
function cacheGet(k){ const e=cache[k]; if(!e) return null; if(Date.now()-e.ts>e.ttl){delete cache[k];return null;} return e.data; }
function cacheSet(k,d,ttl){ cache[k]={data:d,ts:Date.now(),ttl}; }

// ── MIDDLEWARE ───────────────────────────────────────────────────
function requireClient(req,res,next){
  const code=(req.headers['x-client-code']||'').toUpperCase();
  const c=getCliente(code);
  if(!c) return res.status(401).json({error:'Cliente no reconocido'});
  req.partnerId=c.partnerId; req.clientName=c.name; req.multiplicador=c.multiplicador||3;
  next();
}

// ── PRICELIST ────────────────────────────────────────────────────
async function getPricelistId(partnerId) {
  const cached=cacheGet('pl_'+partnerId); if(cached!==null) return cached;
  const r=await xmlrpcCall('res.partner','read',[[partnerId],['property_product_pricelist']]);
  const pl=r[0]?.property_product_pricelist;
  const plId=Array.isArray(pl)?pl[0]:null;
  cacheSet('pl_'+partnerId,plId,3600000); return plId;
}

// ── FETCH PRODUCTOS BASE ─────────────────────────────────────────
async function fetchProductos() {
  const cached=cacheGet('productos'); if(cached) return cached;

  const categIds=await xmlrpcCall('product.category','search',[[['complete_name','in',CATEGORIAS_OK]]]);
  const domain=[['sale_ok','=',true],['active','=',true]];
  if(categIds.length) domain.push(['categ_id','in',categIds]);

  const prodIds=await xmlrpcCall('product.product','search',[domain]);
  if(!prodIds.length) return [];

  const result=[];
  for(let i=0;i<prodIds.length;i+=200){
    const chunk=prodIds.slice(i,i+200);
    const prods=await xmlrpcCall('product.product','read',[chunk,[
      'id','default_code','name','list_price','categ_id',
      'image_128','barcode','qty_available',
      'product_template_attribute_value_ids','product_tmpl_id'
    ]]);

    const tmplIds=[...new Set(prods.map(p=>Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id))];
    let tmplMap={};
    if(tmplIds.length){
      const tmpls=await xmlrpcCall('product.template','read',[tmplIds,['id','metal_type','rock_type','description_sale']]);
      tmpls.forEach(t=>{tmplMap[t.id]=t;});
    }

    const attrValIds=[...new Set(prods.flatMap(p=>p.product_template_attribute_value_ids||[]))];
    let attrMap={};
    if(attrValIds.length){
      const attrVals=await xmlrpcCall('product.template.attribute.value','read',[attrValIds,['id','product_attribute_value_id']]);
      const pavIds=attrVals.map(v=>Array.isArray(v.product_attribute_value_id)?v.product_attribute_value_id[0]:null).filter(Boolean);
      let pavMap={};
      if(pavIds.length){
        const pavs=await xmlrpcCall('product.attribute.value','read',[pavIds,['id','name']]);
        pavs.forEach(v=>{pavMap[v.id]=v.name;});
      }
      attrVals.forEach(v=>{
        const pavId=Array.isArray(v.product_attribute_value_id)?v.product_attribute_value_id[0]:null;
        attrMap[v.id]=pavId?pavMap[pavId]:'';
      });
    }

    prods.forEach(p=>{
      const tmplId=Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id;
      const tmpl=tmplMap[tmplId]||{};
      const medidas=(p.product_template_attribute_value_ids||[]).map(id=>attrMap[id]||'').filter(Boolean);
      result.push({
        id:p.id, sku:p.default_code||'', nombre:p.name||'',
        descripcion:tmpl.description_sale||'',
        precio:parseFloat(p.list_price||0),
        categoria:Array.isArray(p.categ_id)?p.categ_id[1]:'',
        metal:tmpl.metal_type||'', piedra:tmpl.rock_type||'',
        medida:medidas.join(', '),
        imagen128:p.image_128||null,
        barcode:p.barcode||'',
        stock:parseFloat(p.qty_available||0)
      });
    });
  }
  cacheSet('productos',result,30*60*1000);
  return result;
}

// ════════════════════════════════════════════════════════════════
// MÓDULO 1 — BIBLIOTECA
// ════════════════════════════════════════════════════════════════
app.get('/api/productos', async (req,res)=>{
  try {
    const code=(req.headers['x-client-code']||'').toUpperCase();
    if(!getCliente(code)) return res.status(401).json({error:'Cliente no reconocido'});
    const prods=await fetchProductos();
    // No enviamos imagen128 en el listado (pesa mucho) — solo flag booleano
    res.json(prods.map(p=>({...p,imagen:!!p.imagen128,imagen128:undefined})));
  } catch(e){ console.error('❌ /api/productos',e.message); res.status(500).json({error:e.message}); }
});

app.delete('/api/productos/cache',(_req,res)=>{
  Object.keys(cache).filter(k=>k.startsWith('productos')||k.startsWith('stock_')).forEach(k=>delete cache[k]);
  res.json({ok:true});
});

// ── FOTOS ZIP ────────────────────────────────────────────────────
app.get('/api/fotos', async (req,res)=>{
  try {
    const code=(req.headers['x-client-code']||'').toUpperCase();
    if(!getCliente(code)) return res.status(401).json({error:'Cliente no reconocido'});
    const cat=req.query.categoria||'';
    let prods=await fetchProductos();
    if(cat) prods=prods.filter(p=>p.categoria===cat);
    prods=prods.filter(p=>p.imagen128);
    if(!prods.length) return res.status(404).json({error:'Sin imágenes'});
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="aviv-fotos${cat?'-'+cat.replace(/[\s/]/g,'-'):''}.zip"`);
    const archive=archiver('zip',{zlib:{level:6}});
    archive.pipe(res);
    prods.forEach(p=>{
      const buf=Buffer.from(p.imagen128,'base64');
      archive.append(buf,{name:`${(p.sku||p.id).replace(/[^a-zA-Z0-9_-]/g,'_')}.png`});
    });
    await archive.finalize();
  } catch(e){ console.error('❌ /api/fotos',e.message); if(!res.headersSent) res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════
// MÓDULO 2 — STOCK + PRECIO CON PRICELIST + MULTIPLICADOR
// ════════════════════════════════════════════════════════════════
app.get('/api/stock', async (req,res)=>{
  try {
    const code=(req.headers['x-client-code']||'').toUpperCase();
    const cliente=getCliente(code);
    if(!cliente) return res.status(401).json({error:'Cliente no reconocido'});

    const cached=cacheGet('stock_'+code); if(cached) return res.json(cached);

    let prods=await fetchProductos();
    const plId=await getPricelistId(cliente.partnerId);
    if(plId && prods.length){
      try {
        const ids=prods.map(p=>p.id);
        const precios=await xmlrpcCall('product.pricelist','get_products_price',[[plId],ids,ids.map(()=>1),new Date().toISOString().slice(0,10)]);
        prods=prods.map(p=>({...p,precio:parseFloat(precios[p.id]||p.precio)}));
      } catch(e){ console.warn('⚠ pricelist:',e.message); }
    }

    const mult=cliente.multiplicador||3;
    const result=prods.map(p=>({
      id:p.id, sku:p.sku, des:p.nombre,
      stock:p.stock, precio:p.precio,
      precioSugerido: Math.round(p.precio * mult),
      categoria:p.categoria, metal:p.metal, piedra:p.piedra, medida:p.medida
    }));

    cacheSet('stock_'+code,result,15*60*1000);
    res.json(result);
  } catch(e){ console.error('❌ /api/stock',e.message); res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════════════════════════
// MÓDULO 3 — INGRESO DE VENTAS
// ════════════════════════════════════════════════════════════════
app.post('/api/pedido', requireClient, async (req,res)=>{
  try {
    const {productos,sucursal,nota}=req.body?.data||{};
    if(!productos?.length) return res.status(400).json({error:'Sin productos'});
    const skus=productos.map(p=>p.sku);
    const prodRecs=await xmlrpcCall('product.product','search_read',[[['default_code','in',skus],['active','=',true]],{fields:['id','default_code']}]);
    const skuToId={};
    prodRecs.forEach(p=>{skuToId[p.default_code]=p.id;});
    const orderLines=productos.filter(p=>skuToId[p.sku]).map(p=>[0,0,{product_id:skuToId[p.sku],product_uom_qty:p.quantity,name:p.sku}]);
    if(!orderLines.length) return res.status(400).json({error:'Ningún SKU reconocido'});
    const orderId=await xmlrpcCall('sale.order','create',[{partner_id:req.partnerId,note:[sucursal,nota].filter(Boolean).join(' | '),order_line:orderLines}]);
    await xmlrpcCall('sale.order','action_confirm',[[orderId]]);
    res.json({ok:true,orderId,message:'Pedido creado en Odoo'});
  } catch(e){ console.error('❌ /api/pedido',e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/pedidos', requireClient, async (req,res)=>{
  try {
    const limit=parseInt(req.query.limit||'50');
    const ids=await xmlrpcCall('sale.order','search',[[['partner_id','=',req.partnerId],['state','in',['sale','done','cancel']]],{order:'date_order desc',limit}]);
    if(!ids.length) return res.json([]);
    const orders=await xmlrpcCall('sale.order','read',[ids,['name','date_order','state','amount_total','amount_untaxed','note']]);
    res.json(orders.map(o=>({id:o.id,nombre:o.name,fecha:o.date_order,estado:o.state,total:parseFloat(o.amount_total||0),neto:parseFloat(o.amount_untaxed||0),nota:o.note||''})));
  } catch(e){ console.error('❌ /api/pedidos',e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/me',(req,res)=>{
  const code=(req.headers['x-client-code']||'').toUpperCase();
  const c=getCliente(code);
  if(!c) return res.status(401).json({error:'Cliente no reconocido'});
  res.json({name:c.name,partnerId:c.partnerId,multiplicador:c.multiplicador||3,sucursales:c.sucursales||[]});
});

app.get('/health',(req,res)=>res.json({ok:true,ts:new Date().toISOString()}));

module.exports = app;

// ── IMAGEN INDIVIDUAL ─────────────────────────────────────────────
app.get('/api/imagen/:id', async (req,res)=>{
  try {
    const code=(req.headers['x-client-code']||req.query.c||'').toUpperCase();
    if(!getCliente(code)) return res.status(401).send('No autorizado');

    const id=parseInt(req.params.id);
    if(!id) return res.status(400).send('ID invalido');

    // Intentar caché primero, si no traer directo de Odoo
    let img128 = null;
    const cached = cacheGet('productos');
    if(cached) {
      const prod = cached.find(p=>p.id===id);
      img128 = prod ? prod.imagen128 : null;
    }

    // Si no está en caché, traer solo esta imagen de Odoo
    if(!img128) {
      const prods = await xmlrpcCall('product.product','read',[[id],['image_128']]);
      img128 = prods && prods[0] ? prods[0].image_128 : null;
    }

    if(!img128) {
      // Devolver imagen placeholder transparente 1x1
      const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
      res.setHeader('Content-Type','image/png');
      return res.send(px);
    }

    const buf=Buffer.from(img128,'base64');
    res.setHeader('Content-Type','image/png');
    res.setHeader('Cache-Control','public, max-age=7200');
    res.send(buf);
  } catch(e){
    console.error('❌ /api/imagen/'+req.params.id, e.message);
    res.status(500).send(e.message);
  }
});

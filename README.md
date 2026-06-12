# Aviv · Portal Cliente

Portal web para clientes de Aviv con 3 módulos:
- **Biblioteca** — fichas de productos con descarga Excel
- **Vitrina** — catálogo visual con precio sugerido y stock
- **Ingreso de ventas** — grid de pedidos que va directo a Odoo

## Configuración

### 1. Variables de entorno (en Vercel → Settings → Environment Variables)

| Variable         | Valor                            |
|-----------------|----------------------------------|
| `ODOO_DB`       | Nombre de la base de datos Odoo  |
| `ODOO_USER`     | Email del usuario admin de Odoo  |
| `ODOO_PASSWORD` | Contraseña o API key admin       |

### 2. Clientes (`clientes.csv`)

Mismo formato que Temponovo:

```
codigo,nombre,partnerId,apiKey,sucursales
CODCLIENTE,Nombre Empresa SA,12345,API_KEY_ODOO_DEL_CLIENTE,"Sucursal A,Sucursal B"
```

- **codigo** → lo que escribe el cliente para ingresar
- **partnerId** → ID del partner en Odoo
- **apiKey** → API key personal del cliente en Odoo (Settings → Users → API Keys)
- **sucursales** → separadas por coma, entre comillas si son varias

### 3. Despliegue en Vercel

```bash
npm i -g vercel
vercel --prod
```

## Estructura

```
aviv-portal/
├── server.js       ← API Express (Odoo connector)
├── index.html      ← Frontend completo
├── clientes.csv    ← Credenciales de clientes
├── package.json
└── vercel.json
```

## Endpoints API

| Método | Ruta                    | Descripción                          |
|--------|------------------------|--------------------------------------|
| GET    | /api/me                 | Perfil del cliente (auth check)      |
| GET    | /api/productos          | Catálogo completo con imágenes       |
| DELETE | /api/productos/cache    | Forzar recarga del catálogo          |
| GET    | /api/stock              | Stock y precios del cliente          |
| DELETE | /api/stock/cache        | Forzar recarga de stock              |
| POST   | /api/pedido             | Crear nuevo pedido en Odoo           |
| POST   | /api/pedido-update      | Agregar líneas a pedido existente    |
| GET    | /api/pedidos            | Historial de pedidos del cliente     |
| GET    | /health                 | Health check                         |

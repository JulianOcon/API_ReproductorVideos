const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const mysql = require("mysql2")
const bcrypt = require("bcrypt");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = 3000;
const VIDEOS_DIR = "H:/Videos/categoria";
const THUMBNAILS_DIR = "H:/Videos/thumbnails";

// Middleware
app.use(cors());
app.use('/thumbnails', express.static(THUMBNAILS_DIR));
app.use(express.json());

// IP manual o automática
const IP_MANUAL = "192.168.1.12";
let IP_PUBLICA = IP_MANUAL || "localhost";

// IP dinámica (si no se usa IP_MANUAL)
if (!IP_MANUAL) {
  https.get("https://api.ipify.org?format=json", (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      try {
        const ip = JSON.parse(data).ip;
        IP_PUBLICA = ip;
        console.log("🌐 IP pública detectada:", IP_PUBLICA);
      } catch {
        console.warn("⚠️ No se pudo obtener la IP pública");
      }
    });
  }).on("error", () => {
    console.warn("⚠️ Error al consultar la IP pública");
  });
}

// Conexión BD
let connection;

function handleDisconnect() {
  connection = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "root",
    database: "redlucia"
  });

  connection.connect(err => {
    if (err) {
      console.error("❌ Error al conectar a MySQL:", err);
      setTimeout(handleDisconnect, 2000); // intenta reconectar en 2 segundos
    } else {
      console.log("✅ Conexión a MySQL establecida");
    }
  });

  connection.on("error", err => {
    console.error("⚠️ Error de conexión MySQL:", err);
    if (err.code === "PROTOCOL_CONNECTION_LOST") {
      handleDisconnect(); // reconecta
    } else {
      throw err;
    }
  });
}

handleDisconnect();


// Funciones auxiliares
function listarCategoriasDisponibles() {
  if (!fs.existsSync(VIDEOS_DIR)) return [];
  return fs.readdirSync(VIDEOS_DIR)
    .filter(nombre => fs.lstatSync(path.join(VIDEOS_DIR, nombre)).isDirectory())
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function listarVideosDeCategoria(categoria) {
  const categoriaPath = path.join(VIDEOS_DIR, categoria);
  const thumbCategoriaPath = path.join(THUMBNAILS_DIR, categoria);

  if (!fs.existsSync(categoriaPath)) return [];

  if (!fs.existsSync(thumbCategoriaPath)) {
    fs.mkdirSync(thumbCategoriaPath, { recursive: true });
  }

  const archivos = fs.readdirSync(categoriaPath)
    .filter(nombre => nombre.toLowerCase().endsWith(".mp4"));

  const nombresSinDuplicados = new Set();

  const videosFinales = archivos.filter(nombre => {
    const base = nombre.replace("_faststart", "");
    if (nombresSinDuplicados.has(base)) return false;
    nombresSinDuplicados.add(base);
    return !nombre.includes("_faststart") || archivos.includes(base + "_faststart.mp4");
  });

  return videosFinales.map(nombre => {
    const videoPath = path.join(categoriaPath, nombre);
    const thumbPath = path.join(thumbCategoriaPath, nombre.replace(".mp4", ".jpg"));

    if (!fs.existsSync(thumbPath)) {
      ffmpeg(videoPath)
        .on('error', err => console.error(`❌ Error generando thumbnail: ${nombre}`, err.message))
        .on('end', () => console.log(`✅ Thumbnail generado: ${thumbPath}`))
        .screenshots({
          timestamps: ['10'],
          filename: nombre.replace(".mp4", ".jpg"),
          folder: thumbCategoriaPath,
          size: '320x?'
        });
    }

    const stats = fs.statSync(videoPath);
    return {
      titulo: nombre.replace(/_faststart/g, "").replace(".mp4", ""),
      url: `http://${IP_PUBLICA}:${PORT}/videos/${encodeURIComponent(categoria)}/${encodeURIComponent(nombre)}`,
      thumbnail: `http://${IP_PUBLICA}:${PORT}/thumbnails/${encodeURIComponent(categoria)}/${encodeURIComponent(nombre.replace(".mp4", ".jpg"))}`,
      fecha: stats.mtimeMs
    };
  }).sort((a, b) => b.fecha - a.fecha);
}

// RUTAS API

app.get("/", (req, res) => res.send("¡API de Videos funcionando!"));

app.get("/api/ip", (req, res) => {
  res.json({
    ip_publica: IP_PUBLICA,
    puerto: PORT,
    url_publica: `http://${IP_PUBLICA}:${PORT}/api/`
  });
});

app.get("/api/categorias", (req, res) => {
  const categorias = listarCategoriasDisponibles();
  if (categorias.length === 0) return res.status(404).json({ mensaje: "No se encontraron categorías." });
  res.json(categorias);
});

app.get(["/api/videos", "/api/videos/"], (req, res) => {
  const categorias = listarCategoriasDisponibles();
  let todosLosVideos = [];
  categorias.forEach(cat => {
    todosLosVideos = todosLosVideos.concat(listarVideosDeCategoria(cat));
  });
  if (todosLosVideos.length === 0) return res.status(404).json({ mensaje: "No se encontraron videos." });
  res.json(todosLosVideos);
});

app.get("/api/videos/:categoria", (req, res) => {
  const categoria = req.params.categoria;
  const videos = listarVideosDeCategoria(categoria);
  if (videos.length === 0) return res.status(404).json({ mensaje: "No se encontraron videos para esta categoría." });
  res.json(videos);
});

app.get("/videos/:categoria/:nombre", (req, res) => {
  const { categoria, nombre } = req.params;
  const originalPath = path.join(VIDEOS_DIR, categoria, nombre);
  const isFaststart = nombre.includes("_faststart.mp4");
  const baseNombre = isFaststart ? nombre : nombre.replace(".mp4", "_faststart.mp4");
  const videoFinal = path.join(VIDEOS_DIR, categoria, baseNombre);

  if (!fs.existsSync(originalPath)) return res.status(404).send("Video no encontrado.");

  if (!isFaststart && !fs.existsSync(videoFinal)) {
    console.log(`⚙️ Optimización en curso: ${baseNombre}`);
    return ffmpeg(originalPath)
      .outputOptions("-movflags +faststart")
      .outputOptions("-c copy")
      .on("end", () => {
        console.log(`✅ Optimizado: ${videoFinal}`);
        res.redirect(`/videos/${encodeURIComponent(categoria)}/${encodeURIComponent(baseNombre)}`);
      })
      .on("error", err => {
        console.error(`❌ Error optimizando ${nombre}:`, err.message);
        res.status(500).send("Error al preparar el video.");
      })
      .save(videoFinal);
  }

  const stat = fs.statSync(videoFinal);
  const fileSize = stat.size;
  const range = req.headers.range;
  let start = 0;
  let end = fileSize - 1;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : end;
  }

  const chunksize = end - start + 1;
  const file = fs.createReadStream(videoFinal, { start, end });

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunksize,
    "Content-Type": "video/mp4"
  });

  file.pipe(res);
});

// --- RUTAS DE AUTENTICACIÓN Y USUARIOS ---

app.post("/api/register", (req, res) => {
  console.log("📥 Se recibió solicitud en /api/register");

  const { nombre, apellidos, telefono, contrasena, tipo_usuario } = req.body;
  const usuario = telefono;
  const tiposValidos = ["Basico", "Premium", "Dedicado"];

  // Validar tipo_usuario
  if (!tiposValidos.includes(tipo_usuario)) {
    return res.status(400).json({
      success: false,
      mensaje: `Tipo de usuario inválido. Debe ser uno de: ${tiposValidos.join(", ")}`
    });
  }

  const dispositivos_maximos = tipo_usuario === "Dedicado" ? 5 : 1;

  bcrypt.hash(contrasena, 10, (err, hash) => {
    if (err) {
      console.error("Error al cifrar la contraseña", err);
      return res.status(500).json({
        success: false,
        mensaje: "Error al cifrar contraseña"
      });
    }

    const sql = `
      INSERT INTO usuarios 
      (nombre, apellidos, telefono, usuario, contrasena, tipo_usuario, dispositivos_maximos, estado) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const valores = [
      nombre,
      apellidos,
      telefono,
      usuario,
      hash,
      tipo_usuario,
      dispositivos_maximos,
      'Inactivo' // 👈 se guarda como inactivo
    ];

    connection.query(sql, valores, (err) => {
      if (err) {
        console.error("Error al ejecutar el query de registro", err);
        if (err.code === 'ER_DUP_ENTRY') {
          return res.json({
            success: false,
            mensaje: "Usuario o teléfono ya registrado"
          });
        }
        return res.status(500).json({
          success: false,
          mensaje: "Error al registrar"
        });
      }

      res.json({
        success: true,
        mensaje: "Usuario registrado correctamente. Espera activación del administrador."
      });
    });
  });
});



app.post("/api/login", (req, res) => {
  const { usuario, contrasena } = req.body;

  connection.query(
    "SELECT * FROM usuarios WHERE usuario = ? AND estado = 'Activo'",
    [usuario],
    (err, results) => {
      if (err) return res.status(500).json({ success: false, mensaje: "Error en la base de datos" });

      if (results.length === 0)
        return res.json({ success: false, mensaje: "Usuario no encontrado o inactivo" });

      const user = results[0];

      bcrypt.compare(contrasena, user.contrasena, (err, match) => {
        if (match) {
          res.json({
            success: true,
            mensaje: "Login exitoso",
            usuario: user.usuario,
            tipo_usuario: user.tipo_usuario
          });
        } else {
          res.json({ success: false, mensaje: "Contraseña incorrecta" });
        }
      });
    }
  );
});

app.get("/api/usuarios", (req, res) => {
  const sql = "SELECT id, nombre, apellidos, telefono, usuario, tipo_usuario, estado, dispositivos_maximos FROM usuarios";

  connection.query(sql, (err, results) => {
    if (err) {
      return res.status(500).json({ success: false, mensaje: "Error al consultar usuarios" });
    }

    res.json({
      success: true,
      total: results.length,
      usuarios: results
    });
  });
});

// ⚠️ Esta debe ir al final
app.use((req, res) => res.status(404).json({ mensaje: "Recurso no encontrado" }));

// Iniciar servidor
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor escuchando en http://${IP_PUBLICA}:${PORT}`);
});

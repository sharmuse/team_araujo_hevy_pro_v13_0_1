import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import http from "http";
import nodemailer from "nodemailer";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Rotas de saúde (o Render/Fly/Railway adoram)
app.get("/", (req,res)=> res.send("OK"));
app.get("/healthz", (req,res)=> res.json({ ok:true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// Conexão Postgres (Neon)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Cria tabelas se não existirem
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('PROFESSOR','ALUNO')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trainings (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_exercises (
      id SERIAL PRIMARY KEY,
      training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
      exercise_name TEXT NOT NULL,
      sets INTEGER NOT NULL,
      reps TEXT NOT NULL,
      rest_seconds INTEGER NOT NULL DEFAULT 90,
      order_index INTEGER NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
await init();

// E-mail (real se SMTP setado; se não, loga no console)
let transporter;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
} else {
  transporter = {
    sendMail: async (opts) => { console.log("[EMAIL:DEV] Would send:", opts); return { messageId: "dev-"+Date.now() }; }
  };
}
const SMTP_FROM = process.env.SMTP_FROM || "Team Araújo Hevy Pro <no-reply@localhost>";

// Sockets (notificações in-app)
const userSockets = new Map();
io.on("connection", (socket) => {
  socket.on("auth", (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.userId = payload.id;
      const set = userSockets.get(payload.id) || new Set();
      set.add(socket.id);
      userSockets.set(payload.id, set);
    } catch {}
  });
  socket.on("disconnect", () => {
    const uid = socket.data.userId;
    if (!uid) return;
    const set = userSockets.get(uid);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) userSockets.delete(uid);
  });
});
function emitToUser(userId, event, data) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  sockets.forEach((sid)=> io.to(sid).emit(event, data));
}

// Utilitários mm:ss
function mmssToSeconds(mmss) {
  if (typeof mmss === "number") return mmss;
  if (!mmss) return 90;
  const [m="0", s="0"] = mmss.split(":");
  return (parseInt(m,10)||0)*60 + (parseInt(s,10)||0);
}
function secondsToMmss(sec) {
  const m = Math.floor(sec/60), s = sec%60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// Middleware auth
async function auth(req,res,next){
  const hdr = req.headers.authorization;
  if(!hdr) return res.status(401).json({error:"missing token"});
  try{
    const token = hdr.replace("Bearer ","");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  }catch{ res.status(401).json({error:"invalid token"}); }
}

// Rotas principais
app.post("/api/auth/register", async (req,res)=>{
  const { name, email, password, role } = req.body;
  if(!name || !email || !password || !role) return res.status(400).json({error:"missing fields"});
  if(!["PROFESSOR","ALUNO"].includes(role)) return res.status(400).json({error:"invalid role"});
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      "INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role",
      [name, email.toLowerCase(), hash, role]
    );
    const user = r.rows[0];
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "7d" });

    if (role === "ALUNO") {
      const profs = await pool.query("SELECT id, email, name FROM users WHERE role='PROFESSOR'");
      for (const p of profs.rows) {
        const payload = { studentId: user.id, studentName: user.name, studentEmail: user.email };
        await pool.query("INSERT INTO notifications (user_id, type, payload) VALUES ($1,$2,$3)", [p.id, "NEW_STUDENT", JSON.stringify(payload)]);
        emitToUser(p.id, "notification", { type: "NEW_STUDENT", payload });
        await transporter.sendMail({ from: SMTP_FROM, to: p.email, subject: `Novo aluno cadastrado: ${user.name}`, text: `Aluno: ${user.name} (${user.email}).` });
      }
    }

    res.json({ token, user });
  } catch (e) {
    if (String(e).includes("duplicate key value") && String(e).includes("users_email_key")) {
      return res.status(409).json({ error: "Email já cadastrado." });
    }
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/auth/login", async (req,res)=>{
  const { email, password } = req.body;
  const r = await pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
  const user = r.rows[0];
  if(!user) return res.status(401).json({error:"invalid credentials"});
  const ok = await bcrypt.compare(password, user.password_hash);
  if(!ok) return res.status(401).json({error:"invalid credentials"});
  const token = jwt.sign({ id:user.id, name:user.name, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:"7d" });
  res.json({ token, user: { id:user.id, name:user.name, email:user.email, role:user.role }});
});

app.get("/api/students", auth, async (req,res)=>{
  if(req.user.role!=="PROFESSOR") return res.status(403).json({error:"forbidden"});
  const { rows } = await pool.query("SELECT id, name, email FROM users WHERE role='ALUNO' ORDER BY created_at DESC");
  res.json(rows);
});

app.post("/api/trainings", auth, async (req,res)=>{
  if(req.user.role!=="PROFESSOR") return res.status(403).json({error:"forbidden"});
  const { studentId, title, notes, exercises } = req.body;
  if(!studentId || !title || !Array.isArray(exercises) || exercises.length===0) {
    return res.status(400).json({error:"missing fields"});
  }
  const st = await pool.query("SELECT id, email, name FROM users WHERE id=$1 AND role='ALUNO'", [studentId]);
  const student = st.rows[0];
  if(!student) return res.status(404).json({error:"student not found"});

  const ins = await pool.query(
    "INSERT INTO trainings (student_id, professor_id, title, notes) VALUES ($1,$2,$3,$4) RETURNING id",
    [studentId, req.user.id, title, notes || ""]
  );
  const trainingId = ins.rows[0].id;

  let idx = 0;
  for (const ex of exercises) {
    const restSec = mmssToSeconds(ex.rest);
    await pool.query(
      "INSERT INTO training_exercises (training_id, exercise_name, sets, reps, rest_seconds, order_index) VALUES ($1,$2,$3,$4,$5,$6)",
      [trainingId, ex.exercise_name, ex.sets, ex.reps, restSec, idx++]
    );
  }

  const payload = { trainingId, title, studentId, professorId: req.user.id };
  await pool.query("INSERT INTO notifications (user_id, type, payload) VALUES ($1,$2,$3)", [studentId, "NEW_TRAINING", JSON.stringify(payload)]);
  emitToUser(studentId, "notification", { type: "NEW_TRAINING", payload });

  await transporter.sendMail({ from: SMTP_FROM, to: student.email, subject: `Novo treino: ${title}`, text: `Olá ${student.name}, seu professor criou um novo treino: ${title}.` });
  res.json({ id: trainingId });
});

app.get("/api/trainings/:id", auth, async (req,res)=>{
  const tr = await pool.query("SELECT * FROM trainings WHERE id=$1", [req.params.id]);
  const t = tr.rows[0];
  if(!t) return res.status(404).json({error:"not found"});
  if(!(req.user.role==="PROFESSOR" && req.user.id===t.professor_id) && !(req.user.role==="ALUNO" && req.user.id===t.student_id)){
    return res.status(403).json({error:"forbidden"});
  }
  const exs = (await pool.query(
    "SELECT id, exercise_name, sets, reps, rest_seconds, order_index FROM training_exercises WHERE training_id=$1 ORDER BY order_index ASC",
    [t.id]
  )).rows;
  res.json({
    id:t.id, title:t.title, notes:t.notes, studentId:t.student_id, professorId:t.professor_id,
    exercises: exs.map(e=>({ id:e.id, exercise_name:e.exercise_name, sets:e.sets, reps:e.reps, rest:e.rest_seconds, rest_mmss: secondsToMmss(e.rest_seconds), order_index:e.order_index }))
  });
});

app.get("/api/notifications", auth, async (req,res)=>{
  const { rows } = await pool.query("SELECT id, type, payload, read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.user.id]);
  res.json(rows.map(r=>({ id:r.id, type:r.type, payload: JSON.parse(r.payload), read: !!r.read, created_at: r.created_at })));
});
app.post("/api/notifications/:id/read", auth, async (req,res)=>{
  await pool.query("UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ ok:true });
});

server.listen(PORT, ()=> console.log("Server listening on http://localhost:"+PORT));

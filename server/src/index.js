
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import http from "http";
import nodemailer from "nodemailer";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// SQLite
const db = await open({
  filename: "./db/app.db",
  driver: sqlite3.Database
});

await db.exec((await (await import('fs/promises')).readFile("./db/schema.sql")).toString());

// Email: create transporter (falls back to "console" if not configured)
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
    sendMail: async (opts) => {
      console.log("[EMAIL:DEV] Would send:", opts);
      return { messageId: "dev-" + Date.now() };
    }
  };
}
const SMTP_FROM = process.env.SMTP_FROM || "Team Araújo Hevy Pro <no-reply@localhost>";


// In-memory map: userId -> socketId(s)
const userSockets = new Map();
io.on("connection", (socket) => {
  socket.on("auth", (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.userId = payload.id;
      const arr = userSockets.get(payload.id) || new Set();
      arr.add(socket.id);
      userSockets.set(payload.id, arr);
    } catch (e) {
      console.warn("Invalid socket auth");
    }
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

function mmssToSeconds(mmss) {
  // mm:ss or number in seconds
  if (typeof mmss === "number") return mmss;
  if (!mmss) return 90;
  const parts = mmss.split(":");
  if (parts.length !== 2) return parseInt(mmss, 10) || 90;
  const m = parseInt(parts[0], 10) || 0;
  const s = parseInt(parts[1], 10) || 0;
  return m*60 + s;
}

function secondsToMmss(sec) {
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// Auth middleware
async function auth(req,res,next){
  const hdr = req.headers.authorization;
  if(!hdr) return res.status(401).json({error:"missing token"});
  try{
    const token = hdr.replace("Bearer ","");
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  }catch(e){
    res.status(401).json({error:"invalid token"});
  }
}

// Register
app.post("/api/auth/register", async (req,res)=>{
  const { name, email, password, role } = req.body;
  if(!name || !email || !password || !role) return res.status(400).json({error:"missing fields"});
  if(!["PROFESSOR","ALUNO"].includes(role)) return res.status(400).json({error:"invalid role"});
  const hash = await bcrypt.hash(password, 10);
  try {
    const result = await db.run("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)", [name, email.toLowerCase(), hash, role]);
    const user = { id: result.lastID, name, email: email.toLowerCase(), role };
    const token = jwt.sign({ id:user.id, name, email:user.email, role }, JWT_SECRET, { expiresIn: "7d" });

    // If new student -> notify all professors
    if (role === "ALUNO") {
      const profs = await db.all("SELECT id, email, name FROM users WHERE role='PROFESSOR'");
      for (const p of profs) {
        const payload = { studentId: user.id, studentName: user.name, studentEmail: user.email };
        await db.run("INSERT INTO notifications (user_id, type, payload) VALUES (?,?,?)", [p.id, "NEW_STUDENT", JSON.stringify(payload)]);
        emitToUser(p.id, "notification", { type: "NEW_STUDENT", payload });
        // email
        await transporter.sendMail({
          from: SMTP_FROM,
          to: p.email,
          subject: `Novo aluno cadastrado: ${user.name}`,
          text: `Um novo aluno se cadastrou: ${user.name} (${user.email}).`,
        });
      }
    }

    res.json({ token, user });
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed: users.email")) {
      return res.status(409).json({ error: "Email já cadastrado." });
    }
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

// Login
app.post("/api/auth/login", async (req,res)=>{
  const { email, password } = req.body;
  const user = await db.get("SELECT * FROM users WHERE email=?", [email.toLowerCase()]);
  if(!user) return res.status(401).json({error:"invalid credentials"});
  const ok = await bcrypt.compare(password, user.password_hash);
  if(!ok) return res.status(401).json({error:"invalid credentials"});
  const token = jwt.sign({ id:user.id, name:user.name, email:user.email, role:user.role }, JWT_SECRET, { expiresIn:"7d" });
  res.json({ token, user: { id:user.id, name:user.name, email:user.email, role:user.role }});
});

// List students (for professors)
app.get("/api/students", auth, async (req,res)=>{
  if(req.user.role!=="PROFESSOR") return res.status(403).json({error:"forbidden"});
  const students = await db.all("SELECT id, name, email FROM users WHERE role='ALUNO' ORDER BY created_at DESC");
  res.json(students);
});

// Create training
app.post("/api/trainings", auth, async (req,res)=>{
  if(req.user.role!=="PROFESSOR") return res.status(403).json({error:"forbidden"});
  const { studentId, title, notes, exercises } = req.body;
  if(!studentId || !title || !Array.isArray(exercises) || exercises.length===0){
    return res.status(400).json({error:"missing fields"});
  }
  const student = await db.get("SELECT id, email, name FROM users WHERE id=? AND role='ALUNO'", [studentId]);
  if(!student) return res.status(404).json({error:"student not found"});
  const result = await db.run("INSERT INTO trainings (student_id, professor_id, title, notes) VALUES (?,?,?,?)",
    [studentId, req.user.id, title, notes || ""]);
  const trainingId = result.lastID;

  let idx = 0;
  for (const ex of exercises){
    const restSec = mmssToSeconds(ex.rest);
    await db.run("INSERT INTO training_exercises (training_id, exercise_name, sets, reps, rest_seconds, order_index) VALUES (?,?,?,?,?,?)",
      [trainingId, ex.exercise_name, ex.sets, ex.reps, restSec, idx++]);
  }

  const payload = { trainingId, title, studentId, professorId: req.user.id };
  // in-app notification
  await db.run("INSERT INTO notifications (user_id, type, payload) VALUES (?,?,?)", [studentId, "NEW_TRAINING", JSON.stringify(payload)]);
  emitToUser(studentId, "notification", { type: "NEW_TRAINING", payload });

  // email to student
  await transporter.sendMail({
    from: SMTP_FROM,
    to: student.email,
    subject: `Novo treino disponível: ${title}`,
    text: `Olá ${student.name}, seu professor criou um novo treino: ${title}. Abra o app para ver os detalhes.`,
  });

  res.json({ id: trainingId });
});

// Get training details (for student or professor)
app.get("/api/trainings/:id", auth, async (req,res)=>{
  const t = await db.get("SELECT * FROM trainings WHERE id=?", [req.params.id]);
  if(!t) return res.status(404).json({error:"not found"});
  if(!(req.user.role==="PROFESSOR" && req.user.id===t.professor_id) && !(req.user.role==="ALUNO" && req.user.id===t.student_id)){
    // allow professor to fetch any training they created; student can fetch own
    if(req.user.role==="PROFESSOR" && req.user.id===t.professor_id || (req.user.role==="ALUNO" && req.user.id===t.student_id)){
      // ok
    } else {
      return res.status(403).json({error:"forbidden"});
    }
  }
  const exs = await db.all("SELECT id, exercise_name, sets, reps, rest_seconds, order_index FROM training_exercises WHERE training_id=? ORDER BY order_index ASC", [t.id]);
  res.json({
    id: t.id,
    title: t.title,
    notes: t.notes,
    studentId: t.student_id,
    professorId: t.professor_id,
    exercises: exs.map(e=>({ id: e.id, exercise_name: e.exercise_name, sets: e.sets, reps: e.reps, rest: e.rest_seconds, rest_mmss: secondsToMmss(e.rest_seconds), order_index: e.order_index }))
  });
});

// Notifications
app.get("/api/notifications", auth, async (req,res)=>{
  const rows = await db.all("SELECT id, type, payload, read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [req.user.id]);
  res.json(rows.map(r=>({ id:r.id, type:r.type, payload: JSON.parse(r.payload), read: !!r.read, created_at: r.created_at })));
});

app.post("/api/notifications/:id/read", auth, async (req,res)=>{
  await db.run("UPDATE notifications SET read=1 WHERE id=? AND user_id=?", [req.params.id, req.user.id]);
  res.json({ ok:true });
});

server.listen(PORT, ()=>{
  console.log("Server listening on http://localhost:"+PORT);
});


import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

type User = { id:number; name:string; email:string; role:"PROFESSOR"|"ALUNO" };
type Training = { id:number; title:string; notes?:string; studentId:number; professorId:number; exercises: Exercise[] };
type Exercise = { id:number; exercise_name:string; sets:number; reps:string; rest:number; rest_mmss:string; order_index:number };
type Notification = { id:number; type:"NEW_STUDENT"|"NEW_TRAINING"; payload:any; read:boolean; created_at:string };

function useAuth(){
  const [token,setToken] = useState<string|null>(localStorage.getItem("token"));
  const [user,setUser] = useState<User | null>(token ? JSON.parse(localStorage.getItem("user")||"null") : null);
  function save(t:string,u:User){ localStorage.setItem("token", t); localStorage.setItem("user", JSON.stringify(u)); setToken(t); setUser(u); }
  function logout(){ localStorage.clear(); setToken(null); setUser(null); }
  const client = useMemo(()=> axios.create({ baseURL: API, headers: token ? { Authorization:`Bearer ${token}` } : {} }), [token]);
  return { token, user, save, logout, client };
}

function mmssToSeconds(v:string){
  const [m,s] = v.split(":").map(n=>parseInt(n||"0",10));
  return m*60 + s;
}
function secondsToMmss(sec:number){
  const m = Math.floor(sec/60), s = sec%60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

export default function App(){
  const { token, user, save, logout, client } = useAuth();
  const [tab, setTab] = useState<"auth"|"prof"|"aluno">("auth");
  const [notifs, setNotifs] = useState<Notification[]>([]);

  useEffect(()=>{
    if(!token) return;
    const socket = io(API);
    socket.on("connect", ()=> socket.emit("auth", token));
    socket.on("notification", (n:any)=>{
      setNotifs(prev => [{ id: Date.now(), type: n.type, payload: n.payload, read:false, created_at: new Date().toISOString() }, ...prev]);
    });
    return ()=> socket.disconnect();
  }, [token]);

  useEffect(()=>{ if(user){ setTab(user.role==="PROFESSOR" ? "prof" : "aluno"); fetchNotifs(); }}, [user]);

  async function fetchNotifs(){
    if(!token) return;
    const { data } = await client.get("/api/notifications");
    setNotifs(data);
  }

  if(!token) return <Auth onLogin={(t,u)=>save(t,u)} />;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="logo" className="w-10 h-10" />
          <div>
            <div className="font-bold text-xl">Team Araújo Hevy Pro</div>
            <div className="text-xs opacity-70">Bem-vindo, {user!.name} ({user!.role})</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button className="badge" onClick={fetchNotifs}>Notificações: {notifs.filter(n=>!n.read).length} novas</button>
          <button className="btn" onClick={logout}>Sair</button>
        </div>
      </header>

      <nav className="flex gap-2">
        {user!.role==="PROFESSOR" && <button className={"btn " + (tab==="prof"?"":"opacity-70")} onClick={()=>setTab("prof")}>Área do Professor</button>}
        {user!.role==="ALUNO" && <button className={"btn " + (tab==="aluno"?"":"opacity-70")} onClick={()=>setTab("aluno")}>Área do Aluno</button>}
      </nav>

      {tab==="prof" && <ProfessorView client={client} user={user!} />}
      {tab==="aluno" && <AlunoView client={client} user={user!} />}

      <section className="card">
        <h3 className="font-semibold mb-2">Notificações</h3>
        <ul className="space-y-2">
          {notifs.map((n)=> (
            <li key={n.id} className="bg-gray-800/60 rounded-lg p-3">
              <div className="text-sm opacity-70">{new Date(n.created_at).toLocaleString()}</div>
              <div className="font-semibold">{n.type==="NEW_STUDENT"?"Novo aluno":"Novo treino"}</div>
              <pre className="whitespace-pre-wrap">{JSON.stringify(n.payload,null,2)}</pre>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Auth({ onLogin }:{ onLogin:(t:string,u:any)=>void }){
  const [isRegister,setIsRegister] = useState(false);
  const [form,setForm] = useState({ name:"", email:"", password:"", role:"ALUNO" });
  async function submit(){
    try{
      const url = isRegister ? "/api/auth/register" : "/api/auth/login";
      const { data } = await axios.post(API + url, isRegister ? form : { email:form.email, password:form.password });
      onLogin(data.token, data.user);
    }catch(e:any){
      alert(e?.response?.data?.error || "Erro");
    }
  }
  return (
    <div className="min-h-screen grid place-items-center">
      <div className="card w-full max-w-md space-y-4">
        <div className="flex items-center gap-3 justify-center">
          <img src="/logo.png" className="w-12 h-12" />
          <h1 className="text-2xl font-bold">Team Araújo Hevy Pro</h1>
        </div>
        {isRegister && <input className="input" placeholder="Nome" value={form.name} onChange={e=>setForm({...form, name:e.target.value})}/>}
        <input className="input" placeholder="Email" value={form.email} onChange={e=>setForm({...form, email:e.target.value})}/>
        <input className="input" type="password" placeholder="Senha" value={form.password} onChange={e=>setForm({...form, password:e.target.value})}/>
        {isRegister && (
          <select className="input" value={form.role} onChange={e=>setForm({...form, role:e.target.value})}>
            <option value="ALUNO">Aluno</option>
            <option value="PROFESSOR">Professor</option>
          </select>
        )}
        <button className="btn w-full" onClick={submit}>{isRegister?"Cadastrar":"Entrar"}</button>
        <button className="text-sm underline opacity-80" onClick={()=>setIsRegister(!isRegister)}>
          {isRegister?"Já tenho conta":"Quero me cadastrar"}
        </button>
        <p className="text-xs opacity-70 text-center">Email único em todo o sistema (evita duplicidade entre Professor/Aluno).</p>
      </div>
    </div>
  );
}

function ProfessorView({ client, user }:{ client:any; user:User }){
  const [students,setStudents] = useState<User[]>([]);
  const [title,setTitle] = useState("");
  const [notes,setNotes] = useState("");
  const [studentId,setStudentId] = useState<number|undefined>(undefined);
  const [exs,setExs] = useState<{ exercise_name:string; sets:number; reps:string; rest:string }[]>([
    { exercise_name:"Supino reto", sets:4, reps:"8-10", rest:"01:30" }
  ]);

  async function load(){
    const { data } = await client.get("/api/students");
    setStudents(data);
    if(!studentId && data.length>0) setStudentId(data[0].id);
  }
  useEffect(()=>{ load(); },[]);

  function addEx(){ setExs([...exs, { exercise_name:"", sets:3, reps:"10-12", rest:"01:30" }]); }
  function updateEx(i:number,key:string,val:any){
    const arr = exs.slice();
    // normalize rest to mm:ss
    if(key==="rest"){
      const onlyDigits = val.replace(/[^\d]/g,"");
      let m = onlyDigits.slice(0,2);
      let s = onlyDigits.slice(2,4);
      val = `${m.padEnd(2,"0")}:${(s||"00").padEnd(2,"0")}`;
    }
    (arr as any)[i][key] = val;
    setExs(arr);
  }

  async function create(){
    if(!studentId) return alert("Selecione um aluno");
    const payload = { studentId, title, notes, exercises: exs.map(x=>({ ...x, rest: x.rest })) };
    try{
      const { data } = await client.post("/api/trainings", payload);
      alert("Treino criado! ID "+data.id+" — aluno notificado por app e email.");
      setTitle(""); setNotes(""); setExs([{ exercise_name:"Supino reto", sets:4, reps:"8-10", rest:"01:30" }]);
    }catch(e:any){
      alert(e?.response?.data?.error || "Erro ao criar treino");
    }
  }

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div className="card">
        <h2 className="font-bold text-lg mb-3">Alunos recém-cadastrados</h2>
        <ul className="space-y-2 max-h-96 overflow-auto">
          {students.map(s=> (
            <li key={s.id} className={"p-2 rounded-lg border " + (studentId===s.id?"border-emerald-500 bg-emerald-900/10":"border-gray-700")}>
              <button onClick={()=>setStudentId(s.id)} className="w-full text-left">
                <div className="font-semibold">{s.name}</div>
                <div className="text-xs opacity-70">{s.email}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="card space-y-3">
        <h2 className="font-bold text-lg">Criar treino</h2>
        <input className="input" placeholder="Título do treino" value={title} onChange={e=>setTitle(e.target.value)} />
        <textarea className="input" placeholder="Notas" value={notes} onChange={e=>setNotes(e.target.value)} />
        <div className="space-y-2">
          <div className="font-semibold">Exercícios</div>
          {exs.map((ex,i)=> (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <input className="input col-span-4" placeholder="Exercício" value={ex.exercise_name} onChange={e=>updateEx(i,"exercise_name",e.target.value)} />
              <input className="input col-span-2" type="number" min={1} placeholder="Séries" value={ex.sets} onChange={e=>updateEx(i,"sets",parseInt(e.target.value))} />
              <input className="input col-span-2" placeholder="Reps" value={ex.reps} onChange={e=>updateEx(i,"reps",e.target.value)} />
              <input title="Descanso (mm:ss)" className="input col-span-3" placeholder="mm:ss" value={ex.rest} onChange={e=>updateEx(i,"rest",e.target.value)} />
              <span className="text-xs col-span-1">⏱</span>
            </div>
          ))}
          <button className="badge" onClick={addEx}>+ adicionar exercício</button>
        </div>
        <button className="btn" onClick={create}>Salvar treino</button>
        <p className="text-xs opacity-70">Formato de descanso padrão mm:ss (ex.: 01:30), igual apps robustos.</p>
      </div>
    </div>
  );
}

function RestTimer({ initial }:{ initial:number }){
  const [sec,setSec] = useState(initial);
  useEffect(()=>{
    setSec(initial);
  },[initial]);
  useEffect(()=>{
    if(sec<=0) return;
    const t = setInterval(()=> setSec(s=>s-1), 1000);
    return ()=> clearInterval(t);
  },[sec]);
  return (
    <div className="flex items-center gap-2">
      <span className="badge">Descanso</span>
      <span className="font-mono text-lg">{secondsToMmss(Math.max(sec,0))}</span>
    </div>
  );
}

function AlunoView({ client, user }:{ client:any; user:User }){
  const [trainingId,setTrainingId] = useState<number|undefined>(undefined);
  const [training,setTraining] = useState<Training | null>(null);

  async function loadLast(){
    // naive: fetch last created for this student
    const res = await client.get("/api/notifications");
    const nt = (res.data as Notification[]).find(n=>n.type==="NEW_TRAINING");
    if(nt?.payload?.trainingId) setTrainingId(nt.payload.trainingId);
  }

  useEffect(()=>{ loadLast(); },[]);
  useEffect(()=>{
    if(!trainingId) return;
    client.get("/api/trainings/"+trainingId).then(({data})=> setTraining(data));
  },[trainingId]);

  if(!training) return <div className="card">Aguardando um treino do professor…</div>;

  return (
    <div className="card space-y-3">
      <h2 className="font-bold text-xl">{training.title}</h2>
      {training.notes && <p className="opacity-80">{training.notes}</p>}
      <ul className="space-y-3">
        {training.exercises.map((ex)=> (
          <li key={ex.id} className="p-3 rounded-lg border border-gray-700">
            <div className="font-semibold">{ex.exercise_name}</div>
            <div className="text-sm opacity-80">Séries: {ex.sets} • Reps: {ex.reps}</div>
            <RestTimer initial={ex.rest} />
          </li>
        ))}
      </ul>
    </div>
  );
}

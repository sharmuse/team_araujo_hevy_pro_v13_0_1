# Team Araújo Hevy Pro v13

Correções e melhorias solicitadas:

- ✅ **Email único** (impede duplicar contas com o mesmo email entre Professor/Aluno).
- ✅ **Logo aparece** (colocada em `client/public/logo.png` e usada no header/login).
- ✅ **Estrutura de séries organizada** (exercícios com `sets`, `reps` e **descanso em mm:ss**).
- ✅ **Descanso no padrão de apps robustos**: entrada `mm:ss` e **cronômetro** no app do aluno.
- ✅ **Alunos recém-cadastrados aparecem imediatamente** para o Professor (lista e seleção).
- ✅ **Notificações no app e por email**:
  - Professor recebe **novo aluno cadastrado**.
  - Aluno recebe **novo treino criado**.
- ✅ **Socket.IO** para push em tempo real + endpoint para listar notificações.

## Como rodar localmente

1) **Server**
```bash
cd server
npm i
cp .env.example .env   # edite SMTP se quiser email real
npm run dev
```
O servidor subirá em `http://localhost:4000`.

2) **Client**
```bash
cd ../client
npm i
npm run dev
```
Abra `http://localhost:5173`.

> Se quiser apontar o client para outro backend, crie `.env` na pasta `client` com `VITE_API_URL="https://seu-backend"`.

## Email (SMTP)

Preencha as variáveis no `server/.env`. Se não preencher, o servidor **imprime no console** as mensagens que seriam enviadas.

## Observações

- Quando um **Aluno** se cadastra, **todos os Professores** recebem notificação (em app + email).
- O Professor cria o treino com descansos **em `mm:ss`** (armazenados em segundos). O app do aluno mostra um cronômetro por exercício.
- Banco: `sqlite` (arquivo em `server/db/app.db`). Esquema em `server/db/schema.sql`.

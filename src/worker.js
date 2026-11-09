import { DurableObject } from "cloudflare:workers";
import { isObj, clone, getAt, applyOps, permOfCore, PERM_TABS, NOJOB } from "./core.js";

/* ===== 공통 ===== */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};
const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS } });
const E = (status, message, extra) => J({ error: message, ...(extra || {}) }, status);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n = 16) => hex(crypto.getRandomValues(new Uint8Array(n)));
const enc = new TextEncoder();
const now = () => Date.now();
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const MIN = 60 * 1000;
async function pwHash(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 20000 }, key, 256);
  return hex(bits);
}
const safeEq = (a, b) => {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const bearer = (req, url) => {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return url.searchParams.get("token") || "";
};
const body = async (req) => {
  try {
    return await req.json();
  } catch (e) {
    return {};
  }
};
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
// 저장 위치를 아시아·태평양 지역으로 지정 (처음 만들 때 적용)
const reg = (env) => env.REGISTRY.get(env.REGISTRY.idFromName("registry"), { locationHint: "apac" });
const room = (env, id) => env.CLASSROOM.get(env.CLASSROOM.idFromName(id), { locationHint: "apac" });

/* ===== 입구 ===== */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const p = url.pathname.slice(5).split("/").filter(Boolean);
    try {
      if (p[0] === "health") return J({ ok: true, app: "class-econ", v: 1 });
      if (p[0] === "reg" || p[0] === "sys" || p[0] === "student") return await reg(env).fetch(req);
      if (p[0] === "c" && /^[a-f0-9]{20}$/.test(p[1] || "")) return await room(env, p[1]).fetch(req);
      return E(404, "없는 주소입니다.");
    } catch (e) {
      return E(500, "서버에서 문제가 생겼습니다. 잠시 뒤 다시 해 주세요.");
    }
  }
};

/* ===== 반 목록 · 시스템 관리자 · 수업 코드 ===== */
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS classes (id TEXT PRIMARY KEY, school TEXT, cls TEXT, nkey TEXT UNIQUE, salt TEXT, hash TEXT, hint TEXT, created INTEGER, last INTEGER, fails INTEGER DEFAULT 0, lock INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, cid TEXT, exp INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sess (tok TEXT PRIMARY KEY, exp INTEGER)`);
  }
  kv(k, v) {
    if (v === undefined) {
      const r = this.sql.exec(`SELECT v FROM kv WHERE k=?`, k).toArray()[0];
      return r ? JSON.parse(r.v) : null;
    }
    this.sql.exec(`INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)`, k, JSON.stringify(v));
  }
  cls(id) {
    return this.sql.exec(`SELECT * FROM classes WHERE id=?`, id).toArray()[0] || null;
  }
  label(c) {
    return `${c.school} ${c.cls}`;
  }
  /* 수업 코드: 반 저장소가 부른다 */
  async setCode(cid, exp) {
    this.sql.exec(`DELETE FROM codes WHERE exp<? OR cid=?`, now(), cid);
    for (let i = 0; i < 20; i++) {
      const code = newCode();
      if (!this.sql.exec(`SELECT code FROM codes WHERE code=?`, code).toArray().length) {
        this.sql.exec(`INSERT INTO codes (code,cid,exp) VALUES (?,?,?)`, code, cid, exp);
        return code;
      }
    }
    throw new Error("code");
  }
  async dropCode(cid) {
    this.sql.exec(`DELETE FROM codes WHERE cid=?`, cid);
  }
  async touch(cid) {
    this.sql.exec(`UPDATE classes SET last=? WHERE id=?`, now(), cid);
  }
  resolve(code) {
    const r = this.sql.exec(`SELECT * FROM codes WHERE code=? AND exp>?`, String(code || "").toUpperCase().replace(/\s/g, ""), now()).toArray()[0];
    return r ? r.cid : null;
  }
  sysOk(req, url) {
    const t = bearer(req, url);
    if (!t) return false;
    const r = this.sql.exec(`SELECT exp FROM sess WHERE tok=?`, t).toArray()[0];
    return !!(r && r.exp > now());
  }
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.slice(5).split("/").filter(Boolean);
    const b = req.method === "POST" ? await body(req) : {};
    const key = p.join("/");

    /* 새 반 */
    if (key === "reg/create") {
      const school = String(b.school || "").trim().slice(0, 40);
      const c = String(b.cls || "").trim().slice(0, 30);
      if (!school || !c) return E(400, "학교 이름과 반을 모두 적어 주세요.");
      if (String(b.pw || "").length < 4) return E(400, "선생님 비밀번호는 네 글자 이상으로 정해 주세요.");
      const nkey = norm(school) + "|" + norm(c);
      if (this.sql.exec(`SELECT id FROM classes WHERE nkey=?`, nkey).toArray().length) return E(409, "같은 이름의 반이 이미 있습니다. '들어가기'로 들어가 주세요.");
      const id = rand(10);
      const salt = rand(8);
      this.sql.exec(`INSERT INTO classes (id,school,cls,nkey,salt,hash,hint,created,last) VALUES (?,?,?,?,?,?,?,?,?)`, id, school, c, nkey, salt, await pwHash(b.pw, salt), String(b.hint || "").slice(0, 60), now(), now());
      const stub = room(this.env, id);
      await stub.init({ id, school, cls: c });
      const token = await stub.setTeacher(String(b.pw), String(b.hint || ""));
      return J({ classId: id, label: `${school} ${c}`, token });
    }
    /* 선생님 바로 들어가기: 학교 + 반 + 선생님 비밀번호 */
    if (key === "reg/teacher") {
      const r = this.sql.exec(`SELECT * FROM classes WHERE nkey=?`, norm(b.school) + "|" + norm(b.cls)).toArray()[0];
      if (!r) return E(404, "그런 반이 없습니다. 학교와 반 이름을 확인하거나, '처음 쓰는 반'을 눌러 새로 만들어 주세요.", { noClass: true });
      if (r.lock > now()) return E(429, `비밀번호를 여러 번 틀려 ${Math.ceil((r.lock - now()) / MIN)}분 동안 잠겨 있습니다.`);
      const stub = room(this.env, r.id);
      const out = await stub.teacherDirect(String(b.pw || ""));
      if (out.needClassPw) {
        // 선생님 비밀번호가 아직 없거나 초기화된 반: 반 비밀번호로 들어오면 그 비밀번호가 선생님 비밀번호가 된다
        if (!safeEq(await pwHash(b.pw, r.salt), r.hash)) {
          const f = (r.fails || 0) + 1;
          this.sql.exec(`UPDATE classes SET fails=?, lock=? WHERE id=?`, f >= 8 ? 0 : f, f >= 8 ? now() + 10 * MIN : 0, r.id);
          return E(401, "비밀번호가 맞지 않습니다." + (r.hint ? ` 힌트: ${r.hint}` : ""));
        }
        const token = await stub.setTeacher(String(b.pw), r.hint || "");
        this.sql.exec(`UPDATE classes SET fails=0, lock=0, last=? WHERE id=?`, now(), r.id);
        return J({ classId: r.id, label: this.label(r), token });
      }
      if (out.error) return E(out.status || 401, out.error);
      this.sql.exec(`UPDATE classes SET last=? WHERE id=?`, now(), r.id);
      return J({ classId: r.id, label: this.label(r), token: out.token });
    }
    /* 반 들어가기 (선생님 기기) */
    if (key === "reg/login") {
      const r = this.sql.exec(`SELECT * FROM classes WHERE nkey=?`, norm(b.school) + "|" + norm(b.cls)).toArray()[0];
      if (!r) return E(404, "그런 반이 없습니다. 학교와 반 이름을 다시 확인하거나, 오른쪽에서 새 반을 시작해 주세요.");
      if (r.lock > now()) return E(429, `비밀번호를 여러 번 틀려 ${Math.ceil((r.lock - now()) / MIN)}분 동안 잠겨 있습니다.`);
      if (!safeEq(await pwHash(b.pw, r.salt), r.hash)) {
        const f = (r.fails || 0) + 1;
        this.sql.exec(`UPDATE classes SET fails=?, lock=? WHERE id=?`, f >= 8 ? 0 : f, f >= 8 ? now() + 10 * MIN : 0, r.id);
        return E(401, "반 비밀번호가 맞지 않습니다." + (r.hint ? ` 힌트: ${r.hint}` : ""));
      }
      this.sql.exec(`UPDATE classes SET fails=0, lock=0, last=? WHERE id=?`, now(), r.id);
      const pass = await room(this.env, r.id).issuePass();
      return J({ classId: r.id, label: this.label(r), pass });
    }
    /* 학생: 수업 코드 → 명단, 번호 + PIN → 로그인 */
    if (key === "student/code") {
      const cid = this.resolve(b.code);
      if (!cid) return E(404, "수업 코드가 맞지 않거나 수업이 끝났습니다.");
      const c = this.cls(cid);
      const roster = await room(this.env, cid).roster();
      return J({ classId: cid, label: c ? this.label(c) : "", roster });
    }
    if (key === "student/login") {
      const cid = this.resolve(b.code);
      if (!cid) return E(404, "수업 코드가 맞지 않거나 수업이 끝났습니다.");
      const c = this.cls(cid);
      const r = await room(this.env, cid).studentLogin(b.number, b.pin);
      if (r.error) return E(r.status || 401, r.error, r.noPw ? { noPw: true } : undefined);
      return J({ ...r, classId: cid, label: c ? this.label(c) : "" });
    }
    if (key === "student/setpin") {
      const cid = this.resolve(b.code);
      if (!cid) return E(404, "수업 코드가 맞지 않거나 수업이 끝났습니다.");
      const c = this.cls(cid);
      const r = await room(this.env, cid).studentSetPin(b.number, b.pin);
      if (r.error) return E(r.status || 400, r.error);
      return J({ ...r, classId: cid, label: c ? this.label(c) : "" });
    }

    /* 운영자 정보 (개인정보 처리방침에 표시) */
    if (key === "reg/operator") return J({ operator: this.kv("operator") || {} });
    /* 시스템 관리자 */
    if (key === "sys/status") return J({ setup: !!this.kv("sys") });
    if (key === "sys/setup" || key === "sys/login") {
      const sys = this.kv("sys");
      if (key === "sys/setup") {
        if (sys) return E(409, "시스템 관리자 비밀번호가 이미 정해져 있습니다.");
        if (String(b.pw || "").length < 6) return E(400, "시스템 관리자 비밀번호는 여섯 글자 이상으로 정해 주세요.");
        const salt = rand(8);
        this.kv("sys", { salt, hash: await pwHash(b.pw, salt), hint: String(b.hint || "").slice(0, 60) });
      } else {
        if (!sys) return E(400, "시스템 관리자 비밀번호를 먼저 정해 주세요.");
        const lock = this.kv("syslock") || { f: 0, until: 0 };
        if (lock.until > now()) return E(429, `여러 번 틀려 ${Math.ceil((lock.until - now()) / MIN)}분 동안 잠겨 있습니다.`);
        if (!safeEq(await pwHash(b.pw, sys.salt), sys.hash)) {
          const f = lock.f + 1;
          this.kv("syslock", f >= 6 ? { f: 0, until: now() + 15 * MIN } : { f, until: 0 });
          return E(401, "시스템 관리자 비밀번호가 맞지 않습니다." + (sys.hint ? ` 힌트: ${sys.hint}` : ""));
        }
        this.kv("syslock", { f: 0, until: 0 });
      }
      const tok = rand(24);
      this.sql.exec(`DELETE FROM sess WHERE exp<?`, now());
      this.sql.exec(`INSERT INTO sess (tok,exp) VALUES (?,?)`, tok, now() + 60 * MIN);
      return J({ token: tok });
    }
    if (p[0] === "sys") {
      if (!this.sysOk(req, url)) return E(401, "시스템 관리자로 다시 들어가 주세요.");
      if (key === "sys/classes") {
        const list = this.sql.exec(`SELECT id,school,cls,hint,created,last FROM classes ORDER BY created`).toArray();
        const out = [];
        for (const c of list) {
          let st = {};
          try {
            st = await room(this.env, c.id).stats();
          } catch (e) {}
          out.push({ ...c, ...st });
        }
        return J({ classes: out });
      }
      const c = this.cls(b.id);
      if (key === "sys/password") {
        const sys = this.kv("sys");
        if (String(b.pw || "").length < 6) return E(400, "여섯 글자 이상으로 정해 주세요.");
        const salt = rand(8);
        this.kv("sys", { ...sys, salt, hash: await pwHash(b.pw, salt) });
        return J({ ok: true });
      }
      if (key === "sys/operator") {
        const o = b.operator || {};
        const clean = {};
        for (const k of ["name", "owner", "phone", "email", "effective"]) clean[k] = String(o[k] || "").slice(0, 80);
        this.kv("operator", clean);
        return J({ ok: true });
      }
      if (key === "sys/logout") {
        this.sql.exec(`DELETE FROM sess WHERE tok=?`, bearer(req, url));
        return J({ ok: true });
      }
      if (!c) return E(404, "그 반을 찾지 못했습니다.");
      if (key === "sys/class-pw") {
        if (String(b.pw || "").length < 4) return E(400, "반 비밀번호는 네 글자 이상이어야 합니다.");
        const salt = rand(8);
        this.sql.exec(`UPDATE classes SET salt=?, hash=?, fails=0, lock=0 WHERE id=?`, salt, await pwHash(b.pw, salt), c.id);
        return J({ ok: true });
      }
      if (key === "sys/teacher-reset") return J(await room(this.env, c.id).resetTeacher());
      if (key === "sys/wipe") return J(await room(this.env, c.id).wipe());
      if (key === "sys/clear-log") return J(await room(this.env, c.id).clearLog());
      if (key === "sys/delete") {
        await room(this.env, c.id).destroy();
        this.sql.exec(`DELETE FROM classes WHERE id=?`, c.id);
        this.sql.exec(`DELETE FROM codes WHERE cid=?`, c.id);
        return J({ ok: true });
      }
    }
    return E(404, "없는 주소입니다.");
  }
}

/* ===== 반 하나의 저장소 ===== */
const LABEL = { pins: "학생 비밀번호", tx: "통장 거래", weeks: "주간 기록", laws: "우리 반의 법", market: "주식·채권", holdings: "보유 증권", trades: "체결", realized: "실현손익", treasury: "국세청 장부", donations: "기부", bank: "은행", meta: "학생 정보", students: "학생 명단", jobs: "직업", perms: "권한", settings: "설정", titles: "칭호", diliItems: "성실 항목", sheets: "실적표" };
const summarize = (ops) => {
  const m = {};
  for (const o of ops) {
    const k = String((o.path || [])[0] || "기타");
    const kind = o.op === "aput" ? "추가" : o.op === "adel" ? "삭제" : o.op === "ensure" ? null : "수정";
    if (!kind) continue;
    const key = (LABEL[k] || k) + " " + kind;
    m[key] = (m[key] || 0) + 1;
  }
  const parts = Object.entries(m).map(([k, n]) => n > 1 ? `${k} ${n}건` : k);
  return parts.slice(0, 4).join(" · ") + (parts.length > 4 ? " 외" : "") || "변경";
};
// 학생이 고칠 수 있는 곳을 탭으로 나눈다. null은 선생님만.
function areaOf(p) {
  const a = p[0];
  if (a === "laws") return "laws";
  if (a === "weeks") {
    const f = p[2];
    if (f === undefined) return "week";
    if (f === "claps" || f === "praise") return "present";
    if (f === "dili") return "dili";
    if (f === "mealChk" || f === "menu") return "meal";
    if (f === "prizes") return "prize";
    if (f === "etc" || f === "paid" || f === "paidAt") return "pay";
    return null;
  }
  if (a === "treasury" || a === "donations") return "tax";
  if (a === "bank") return p[1] === "accounts" ? "bank" : null;
  if (a === "market") {
    if (p[1] === "bonds") return "bonds";
    if (p[1] !== "stocks") return null;
    // 회사 탭: 회사(=주식) 만들기, 매출·원가 표, 실적 기록 / 지급 내역은 회사(성과급)·주식(배당) 모두
    if (p.length === 2) return "company";
    const f = p[3];
    if (f === "sheets" || f === "fins" || f === "plans" || f === "news") return "company";
    if (f === "payouts") return "payouts";
    return "stocks";
  }
  if (a === "holdings" || a === "trades" || a === "realized") return "market";
  if (a === "tx") return "tx";
  if (a === "meta") return p[2] === "savings" ? "bank" : null;
  return null;
}
const WEEK_TABS = ["present", "dili", "meal", "prize", "pay"];
const TX_TABS = ["bank", "tax", "pay", "stocks", "bonds", "company"];

export class Classroom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS chunks (i INTEGER PRIMARY KEY, s TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS sess (tok TEXT PRIMARY KEY, role TEXT, sid TEXT, exp INTEGER, lesson TEXT)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, summary TEXT, ops TEXT, inv TEXT, undone INTEGER DEFAULT 0)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS pins (sid TEXT PRIMARY KEY, pin TEXT, fails INTEGER DEFAULT 0, lock INTEGER DEFAULT 0)`);
      const rows = this.sql.exec(`SELECT s FROM chunks ORDER BY i`).toArray();
      this.data = rows.length ? JSON.parse(rows.map((r) => r.s).join("")) : null;
    });
  }
  kv(k, v) {
    if (v === undefined) {
      const r = this.sql.exec(`SELECT v FROM kv WHERE k=?`, k).toArray()[0];
      return r ? JSON.parse(r.v) : null;
    }
    if (v === null) this.sql.exec(`DELETE FROM kv WHERE k=?`, k);
    else this.sql.exec(`INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)`, k, JSON.stringify(v));
  }
  seq() {
    return this.kv("seq") || 0;
  }
  save() {
    const s = this.data == null ? "" : JSON.stringify(this.data);
    this.sql.exec(`DELETE FROM chunks`);
    const N = 500000;
    for (let i = 0, k = 0; i < s.length; i += N, k++) this.sql.exec(`INSERT INTO chunks (i,s) VALUES (?,?)`, k, s.slice(i, i + N));
  }
  lesson() {
    return this.kv("lesson") || { open: false };
  }
  /* --- RPC (반 목록 저장소만 부름) --- */
  async init(meta) {
    this.kv("meta", meta);
    return true;
  }
  async issuePass() {
    const tok = rand(24);
    this.sql.exec(`DELETE FROM sess WHERE exp<?`, now());
    this.sql.exec(`INSERT INTO sess (tok,role,sid,exp) VALUES (?,?,?,?)`, tok, "pass", "", now() + 30 * MIN);
    return tok;
  }
  async stats() {
    const d = this.data;
    const size = this.sql.exec(`SELECT COALESCE(SUM(LENGTH(s)),0) AS n FROM chunks`).one().n;
    const logN = this.sql.exec(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(ops)+LENGTH(inv)),0) AS b FROM log`).one();
    const t = this.kv("teacher");
    return { students: d && Array.isArray(d.students) ? d.students.length : 0, size, logCount: logN.n, logSize: logN.b, teacherSet: !!t, teacherHint: t ? t.hint || "" : "", lessonOpen: this.lesson().open };
  }
  async resetTeacher() {
    this.kv("teacher", null);
    this.sql.exec(`DELETE FROM sess WHERE role='teacher'`);
    for (const ws of this.ctx.getWebSockets("teacher")) this.kick(ws, "선생님 비밀번호가 초기화되었습니다.");
    return { ok: true };
  }
  async wipe() {
    if (this.data) {
      const d = this.data;
      this.data = {
        ...d, tx: [], weeks: {}, treasury: [], donations: [], market: { bonds: [], stocks: [] }, holdings: {}, realized: [], trades: [],
        bank: { ...(d.bank || {}), accounts: [] },
        meta: Object.fromEntries(Object.entries(d.meta || {}).map(([k, m]) => [k, { ...m, savings: 0, stocks: 0, bonds: 0 }]))
      };
      this.save();
      this.bump("시스템 관리자", "기록 비우기", [], []);
      this.broadcastRefresh();
    }
    return { ok: true };
  }
  async clearLog() {
    this.sql.exec(`DELETE FROM log`);
    return { ok: true };
  }
  async destroy() {
    for (const ws of this.ctx.getWebSockets()) this.kick(ws, "반이 삭제되었습니다.");
    await this.ctx.storage.deleteAll();
    this.data = null;
    return { ok: true };
  }
  async roster() {
    const l = this.lesson();
    if (!l.open) return [];
    const len = new Map(this.sql.exec(`SELECT sid,pin FROM pins WHERE pin<>''`).toArray().map((r) => [r.sid, String(r.pin).length]));
    return ((this.data && this.data.students) || []).map((s, i) => ({ no: i + 1, name: s.name || "", pwLen: len.get(s.id) || 0 }));
  }
  /* 선생님 비밀번호 바로 확인 (반 목록 저장소가 부름) */
  async teacherDirect(pw) {
    const t = this.kv("teacher");
    if (!t) return { needClassPw: true };
    if ((t.until || 0) > now()) return { error: `여러 번 틀려 ${Math.ceil((t.until - now()) / MIN)}분 동안 잠겨 있습니다.`, status: 429 };
    if (!safeEq(await pwHash(pw, t.salt), t.hash)) {
      const f = (t.f || 0) + 1;
      this.kv("teacher", { ...t, f: f >= 6 ? 0 : f, until: f >= 6 ? now() + 10 * MIN : 0 });
      return { error: "비밀번호가 맞지 않습니다." + (t.hint ? ` 힌트: ${t.hint}` : ""), status: 401 };
    }
    this.kv("teacher", { ...t, f: 0, until: 0 });
    return { token: this.teacherToken() };
  }
  async setTeacher(pw, hint) {
    const salt = rand(8);
    this.kv("teacher", { salt, hash: await pwHash(pw, salt), hint: String(hint || "").slice(0, 60) });
    return this.teacherToken();
  }
  teacherToken() {
    const tok = rand(24);
    this.sql.exec(`DELETE FROM sess WHERE exp<?`, now());
    this.sql.exec(`INSERT INTO sess (tok,role,sid,exp) VALUES (?,?,?,?)`, tok, "teacher", "", now() + 12 * 60 * MIN);
    return tok;
  }
  /* 학생이 처음 들어올 때 비밀번호 정하기 */
  async studentSetPin(number, pin) {
    const l = this.lesson();
    if (!l.open) return { error: "지금은 수업이 열려 있지 않습니다.", status: 403 };
    const s = ((this.data && this.data.students) || [])[Number(number) - 1];
    if (!s) return { error: "그 번호의 학생이 없습니다.", status: 404 };
    if (!/^[0-9]{4}$/.test(String(pin || ""))) return { error: "비밀번호는 숫자 네 자리로 정해 주세요.", status: 400 };
    const row = this.sql.exec(`SELECT * FROM pins WHERE sid=?`, s.id).toArray()[0];
    if (row && row.pin) return { error: "이미 비밀번호가 있습니다. 비밀번호를 넣어 들어오세요.", status: 409 };
    this.sql.exec(`INSERT OR REPLACE INTO pins (sid,pin,fails,lock) VALUES (?,?,0,0)`, s.id, String(pin));
    return this.studentLogin(number, pin);
  }
  async studentLogin(number, pin) {
    const l = this.lesson();
    if (!l.open) return { error: "지금은 수업이 열려 있지 않습니다.", status: 403 };
    const list = (this.data && this.data.students) || [];
    const s = list[Number(number) - 1];
    if (!s) return { error: "그 번호의 학생이 없습니다.", status: 404 };
    const row = this.sql.exec(`SELECT * FROM pins WHERE sid=?`, s.id).toArray()[0];
    if (!row || !row.pin) return { error: "아직 비밀번호가 없습니다. 번호를 다시 눌러 비밀번호를 정해 주세요.", status: 403, noPw: true };
    if (row.lock > now()) return { error: "비밀번호를 여러 번 틀려 잠겼습니다. 선생님께 풀어 달라고 하세요.", status: 429 };
    if (!safeEq(String(pin || ""), row.pin)) {
      const f = (row.fails || 0) + 1;
      this.sql.exec(`UPDATE pins SET fails=?, lock=? WHERE sid=?`, f >= 5 ? 0 : f, f >= 5 ? now() + 24 * 60 * MIN : 0, s.id);
      return { error: f >= 5 ? "비밀번호를 5번 틀려 잠겼습니다. 선생님께 풀어 달라고 하세요." : `비밀번호가 맞지 않습니다. (${f}/5)`, status: 401 };
    }
    this.sql.exec(`UPDATE pins SET fails=0, lock=0 WHERE sid=?`, s.id);
    const tok = rand(24);
    this.sql.exec(`INSERT INTO sess (tok,role,sid,exp,lesson) VALUES (?,?,?,?,?)`, tok, "student", s.id, now() + 3 * 60 * MIN, l.code);
    return { token: tok, sid: s.id, name: s.name };
  }
  /* --- 세션 --- */
  who(req, url) {
    const t = bearer(req, url);
    if (!t) return null;
    const r = this.sql.exec(`SELECT * FROM sess WHERE tok=?`, t).toArray()[0];
    if (!r || r.exp < now()) return null;
    if (r.role === "student") {
      const l = this.lesson();
      if (!l.open || l.code !== r.lesson) return null;
      if (!((this.data && this.data.students) || []).some((s) => s.id === r.sid)) return null;
    }
    return { ...r, tok: t };
  }
  actorName(me) {
    if (me.role === "teacher") return "선생님";
    const list = (this.data && this.data.students) || [];
    const i = list.findIndex((s) => s.id === me.sid);
    const job = this.jobOf(me.sid);
    const jn = job === NOJOB ? "" : ((this.data.jobs || []).find((j) => j.id === job) || {}).name;
    return `${i + 1}번 ${i >= 0 ? list[i].name : ""}${jn ? ` (${jn})` : ""}`;
  }
  jobOf(sid) {
    const m = ((this.data && this.data.meta) || {})[sid] || {};
    return m.jobId && (this.data.jobs || []).some((j) => j.id === m.jobId) ? m.jobId : NOJOB;
  }
  /* --- 학생에게 보낼 자료 거르기 --- */
  viewFor(me) {
    const d = this.data;
    if (!d) return d;
    if (me.role === "teacher") {
      if (!d.pins) return d;
      const { pins, ...rest } = d;
      return rest;
    }
    const sid = me.sid;
    const job = this.jobOf(sid);
    const P = (t) => permOfCore(d, job, t);
    const seeOthers = P("students") === "view" || P("students") === "edit";
    const wide = seeOthers || ["bank", "tax", "pay"].some((t) => P(t) !== "none");
    const out = { ...d };
    out.settings = { ...(d.settings || {}) };
    delete out.settings.adminPw;
    delete out.settings.adminHint;
    out.meta = {};
    for (const [k, m] of Object.entries(d.meta || {})) {
      if (k === sid || seeOthers) out.meta[k] = m;
      else {
        const { photo, ...rest } = m || {};
        out.meta[k] = wide ? rest : { jobId: rest.jobId, titleIds: rest.titleIds || [] };
      }
    }
    out.tx = wide ? d.tx || [] : (d.tx || []).filter((t) => t.sid === sid);
    delete out.ai;
    delete out.pins;
    return out;
  }
  /* --- '거래' 권한: 자기 이름의 매수·매도 주문과 그 체결 결과만 허용 --- */
  checkTrade(me, ops) {
    const d = this.data || {};
    const sid = me.sid;
    const job = this.jobOf(sid);
    const kinds = ["bonds", "stocks"].filter((k) => permOfCore(d, job, k) === "trade");
    if (!kinds.length) return false;
    const parts = new Set([sid]);
    let traded = false;
    for (const o of ops) {
      const p = o.path || [];
      if (p[0] === "market" && kinds.includes(p[1]) && p[3] === "trades" && p.length === 4 && o.op === "aput" && isObj(o.value)) {
        if (o.value.buyer !== sid && o.value.seller !== sid) return false;
        parts.add(String(o.value.buyer));
        parts.add(String(o.value.seller));
        traded = true;
      }
    }
    for (const o of ops) {
      const p = o.path || [];
      if (p[0] === "market") {
        if (!kinds.includes(p[1]) || !isObj(p[2])) return false;
        const a = getAt(d, p.slice(0, 3));
        if (!a || a.matured) return false;
        const f = p[3];
        if (f === "history") continue;
        if (f === "price") { if (!traded) return false; continue; }
        if (f === "trades") { if (traded || o.op === "ensure") continue; return false; }
        if (f !== "orders") return false;
        const cur = a.orders || [];
        const find = (id) => cur.find((x) => String(x.id) === String(id));
        if (o.op === "ensure" && p.length === 4) continue;
        if (o.op === "aput" && p.length === 4) {
          const ex = find(o.id);
          if (!ex) {
            if (!isObj(o.value) || o.value.sid !== sid || !(Number(o.value.qty) > 0) || !(Number(o.value.price) > 0)) return false;
            if (o.value.side === "sell") {
              // 자기 계좌에 있는 수량만큼만 팔 수 있다
              const have = Number((((d.holdings || {})[sid] || {})[a.id] || {}).qty) || 0;
              const listed = cur.filter((x) => x.side === "sell" && x.sid === sid).reduce((t, x) => t + (Number(x.qty) || 0), 0);
              if (Number(o.value.qty) + listed > have) return false;
            } else if (o.value.side === "buy") {
              const bal = (d.tx || []).filter((t) => t.sid === sid).reduce((t, x) => t + (x.type === "in" ? Number(x.amount) || 0 : -(Number(x.amount) || 0)), 0);
              if (Number(o.value.qty) * Number(o.value.price) > bal) return false;
            } else return false;
            continue;
          }
          if (!traded || !isObj(o.value) || o.value.sid !== ex.sid || Number(o.value.qty) > Number(ex.qty)) return false;
          continue;
        }
        if (o.op === "adel" && p.length === 4) {
          const ex = find(o.id);
          if (ex && ex.sid !== sid && !traded) return false;
          continue;
        }
        if (o.op === "set" && p.length === 6 && isObj(p[4]) && p[5] === "qty") {
          const ex = find(p[4].i);
          if (!ex || !traded || Number(o.value) > Number(ex.qty)) return false;
          continue;
        }
        return false;
      }
      if (!traded) return false;
      if (p[0] === "holdings") {
        if (p.length === 1 || !parts.has(String(p[1]))) return false;
        continue;
      }
      if (p[0] === "trades" || p[0] === "realized") {
        if (o.op === "ensure" && p.length === 1) continue;
        if (o.op !== "aput" || !isObj(o.value) || !parts.has(String(o.value.sid))) return false;
        continue;
      }
      if (p[0] === "tx") {
        if (o.op !== "aput" || !isObj(o.value) || !parts.has(String(o.value.sid)) || !/ 매[수도] \d/.test(String(o.value.memo || ""))) return false;
        continue;
      }
      return false;
    }
    // 거래 뒤 내 통장이 마이너스가 되면 안 된다
    const bal0 = (d.tx || []).filter((t) => t.sid === sid).reduce((t, x) => t + (x.type === "in" ? Number(x.amount) || 0 : -(Number(x.amount) || 0)), 0);
    const delta = ops.filter((o) => (o.path || [])[0] === "tx" && o.op === "aput" && isObj(o.value) && o.value.sid === sid).reduce((t, o) => t + (o.value.type === "in" ? Number(o.value.amount) || 0 : -(Number(o.value.amount) || 0)), 0);
    if (delta < 0 && bal0 + delta < 0) return false;
    return true;
  }
  /* --- 학생 입력 검사 --- */
  checkStudent(me, ops) {
    if (this.checkTrade(me, ops)) return null;
    const d = this.data || {};
    const sid = me.sid;
    const job = this.jobOf(sid);
    const P = (t) => permOfCore(d, job, t);
    const can = (area) => {
      if (area === "week") return WEEK_TABS.some((t) => P(t) === "edit");
      if (area === "market") return P("stocks") === "edit" || P("bonds") === "edit";
      if (area === "tx") return TX_TABS.some((t) => P(t) === "edit");
      if (area === "payouts") return P("stocks") === "edit" || P("company") === "edit";
      return P(area) === "edit";
    };
    for (const o of ops) {
      const p = o.path || [];
      // 새 주(week)를 처음 만들 때 생기는 빈 칸은, 주간 탭 하나라도 입력 권한이 있으면 허용 (없을 때만 만들어짐)
      if (o.op === "ensure" && p[0] === "weeks" && p.length <= 3 && can("week") && (o.value === undefined || o.value === null || typeof o.value !== "object" || Object.keys(o.value).length === 0 || Array.isArray(o.value) && o.value.every((x) => !x))) continue;
      const area = areaOf(p);
      if (!area) return "이 부분은 선생님만 바꿀 수 있습니다.";
      if (!can(area)) return "이 화면은 입력 권한이 없습니다.";
      // 입력 권한이 있는 화면이면 자기 기록도 입력할 수 있다 (모든 입력은 활동 기록에 남고 선생님이 되돌릴 수 있음)
    }
    return null;
  }
  bump(actor, summary, ops, inv) {
    const seq = this.seq() + 1;
    this.kv("seq", seq);
    this.sql.exec(`INSERT INTO log (seq,ts,actor,summary,ops,inv) VALUES (?,?,?,?,?,?)`, seq, now(), actor, summary, JSON.stringify(ops), JSON.stringify(inv));
    if (seq % 50 === 0) this.sql.exec(`DELETE FROM log WHERE seq <= ?`, seq - 3000);
    return seq;
  }
  /* --- 실시간 --- */
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {}
  }
  kick(ws, reason) {
    this.send(ws, { type: "logout", reason });
    try {
      ws.close(4001, "logout");
    } catch (e) {}
  }
  broadcastOps(seq, ops, from) {
    for (const ws of this.ctx.getWebSockets("teacher")) this.send(ws, { type: "ops", seq, ops, from });
    for (const ws of this.ctx.getWebSockets("student")) this.send(ws, { type: "refresh", seq });
  }
  broadcastRefresh() {
    const seq = this.seq();
    for (const ws of this.ctx.getWebSockets()) this.send(ws, { type: "refresh", seq });
  }
  async webSocketMessage(ws, msg) {
    if (msg === "ping") this.send(ws, { type: "pong" });
  }
  async webSocketClose(ws, code) {
    try {
      ws.close(code, "bye");
    } catch (e) {}
  }
  connected() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets("student")) {
      const t = this.ctx.getTags(ws);
      if (t[1]) ids.add(t[1]);
    }
    return [...ids];
  }
  /* --- HTTP --- */
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.slice(5).split("/").filter(Boolean).slice(2);
    const key = p.join("/");
    const me = this.who(req, url);
    if (key === "ws") {
      if (req.headers.get("upgrade") !== "websocket") return E(426, "websocket");
      if (!me || (me.role !== "teacher" && me.role !== "student")) return E(401, "다시 로그인해 주세요.");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [me.role, me.sid || "t", me.tok.slice(0, 12)]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const b = req.method === "POST" ? await body(req) : {};
    const meta = this.kv("meta");
    if (!meta) return E(404, "그 반을 찾지 못했습니다.");

    /* 선생님 비밀번호 */
    if (key === "teacher/status") {
      if (!me || me.role !== "pass") return E(401, "반에 다시 들어가 주세요.");
      const t = this.kv("teacher");
      return J({ teacherSet: !!t, hint: t ? t.hint || "" : "", lesson: this.lesson().open, label: `${meta.school} ${meta.cls}` });
    }
    if (key === "teacher/setup" || key === "teacher/login") {
      if (!me || me.role !== "pass") return E(401, "반에 다시 들어가 주세요.");
      const t = this.kv("teacher");
      if (key === "teacher/setup") {
        if (t) return E(409, "선생님 비밀번호가 이미 정해져 있습니다.");
        if (String(b.pw || "").length < 4) return E(400, "비밀번호는 네 글자 이상으로 정해 주세요.");
        const salt = rand(8);
        this.kv("teacher", { salt, hash: await pwHash(b.pw, salt), hint: String(b.hint || "").slice(0, 60) });
      } else {
        if (!t) return E(400, "선생님 비밀번호를 먼저 정해 주세요.");
        if ((t.until || 0) > now()) return E(429, `여러 번 틀려 ${Math.ceil((t.until - now()) / MIN)}분 동안 잠겨 있습니다.`);
        if (!safeEq(await pwHash(b.pw, t.salt), t.hash)) {
          const f = (t.f || 0) + 1;
          this.kv("teacher", { ...t, f: f >= 6 ? 0 : f, until: f >= 6 ? now() + 10 * MIN : 0 });
          return E(401, "비밀번호가 맞지 않습니다." + (t.hint ? ` 힌트: ${t.hint}` : ""));
        }
        this.kv("teacher", { ...t, f: 0, until: 0 });
      }
      const tok = rand(24);
      this.sql.exec(`INSERT INTO sess (tok,role,sid,exp) VALUES (?,?,?,?)`, tok, "teacher", "", now() + 12 * 60 * MIN);
      try {
        await reg(this.env).touch(meta.id);
      } catch (e) {}
      return J({ token: tok });
    }
    if (key === "student/login") {
      if (!me || me.role !== "pass") return E(401, "반에 다시 들어가 주세요.");
      const r = await this.studentLogin(b.number, b.pin);
      return r.error ? E(r.status || 401, r.error) : J(r);
    }
    if (key === "student/roster") {
      if (!me || me.role !== "pass") return E(401, "반에 다시 들어가 주세요.");
      return J({ roster: await this.roster(), open: this.lesson().open });
    }
    if (key === "logout") {
      if (me) this.sql.exec(`DELETE FROM sess WHERE tok=?`, me.tok);
      return J({ ok: true });
    }

    if (!me || me.role === "pass") return E(401, "다시 로그인해 주세요.");
    const teacher = me.role === "teacher";

    if (key === "state") {
      return J({ data: this.viewFor(me), seq: this.seq(), me: { role: me.role, sid: me.sid || null }, label: `${meta.school} ${meta.cls}`, lesson: teacher ? this.lesson() : { open: true } });
    }
    if (key === "ops") {
      const ops = Array.isArray(b.ops) ? b.ops : [];
      if (!ops.length) return J({ seq: this.seq() });
      if (ops.some((o) => (o.path || [])[0] === "pins")) return E(400, "학생 비밀번호는 관리자 화면의 '학생 비밀번호'에서 바꿔 주세요.");
      if (JSON.stringify(ops).length > 4 * 1024 * 1024) return E(413, "한 번에 보내는 자료가 너무 큽니다. 사진을 더 작게 줄여 주세요.");
      if (!teacher) {
        const why = this.checkStudent(me, ops);
        if (why) return E(403, why);
      }
      if (this.data == null) this.data = {};
      const inv = applyOps(this.data, ops);
      this.save();
      const seq = this.bump(this.actorName(me), summarize(ops), ops, inv);
      this.broadcastOps(seq, ops, String(b.client || ""));
      return J({ seq });
    }

    if (!teacher) return E(403, "선생님만 할 수 있습니다.");

    if (key === "import") {
      if (!isObj(b.data)) return E(400, "자료 형식이 맞지 않습니다.");
      const { pins: lp, ...nd } = b.data;
      if (isObj(lp)) for (const [sid, pin] of Object.entries(lp)) if (/^[0-9]{4,6}$/.test(String(pin))) this.sql.exec(`INSERT OR REPLACE INTO pins (sid,pin,fails,lock) VALUES (?,?,0,0)`, sid, String(pin));
      this.data = nd;
      this.save();
      this.bump("선생님", "자료 통째로 바꾸기", [], []);
      this.broadcastRefresh();
      return J({ seq: this.seq() });
    }
    if (key === "teacher/change") {
      const t = this.kv("teacher");
      if (!t || !safeEq(await pwHash(b.cur, t.salt), t.hash)) return E(401, "지금 비밀번호가 맞지 않습니다.");
      if (String(b.pw || "").length < 4) return E(400, "새 비밀번호는 네 글자 이상으로 정해 주세요.");
      const salt = rand(8);
      this.kv("teacher", { ...t, salt, hash: await pwHash(b.pw, salt) });
      this.sql.exec(`DELETE FROM sess WHERE role='teacher' AND tok<>?`, me.tok);
      return J({ ok: true });
    }
    if (key === "lesson") return J({ ...this.lesson(), connected: this.connected() });
    if (key === "lesson/open") {
      let l = this.lesson();
      if (!l.open) {
        const exp = now() + 4 * 60 * MIN;
        const code = await reg(this.env).setCode(meta.id, exp);
        l = { open: true, code, openedAt: now(), exp };
        this.kv("lesson", l);
      }
      return J({ ...l, connected: this.connected() });
    }
    if (key === "lesson/close") {
      this.kv("lesson", { open: false, closedAt: now() });
      this.sql.exec(`DELETE FROM sess WHERE role='student'`);
      try {
        await reg(this.env).dropCode(meta.id);
      } catch (e) {}
      for (const ws of this.ctx.getWebSockets("student")) this.kick(ws, "수업이 끝나 로그아웃되었습니다.");
      return J({ open: false });
    }
    if (key === "pins") {
      const rows = this.sql.exec(`SELECT sid,pin,lock FROM pins`).toArray();
      return J({ pins: rows.map((r) => ({ sid: r.sid, pin: r.pin, locked: r.lock > now() })) });
    }
    if (key === "pins/set") {
      const sid = String(b.sid || "");
      if (!((this.data && this.data.students) || []).some((x) => x.id === sid)) return E(404, "그 학생을 찾지 못했습니다.");
      if (!/^[0-9]{4}$/.test(String(b.pin || ""))) return E(400, "비밀번호는 숫자 네 자리로 정해 주세요.");
      this.sql.exec(`INSERT OR REPLACE INTO pins (sid,pin,fails,lock) VALUES (?,?,0,0)`, sid, String(b.pin));
      return J({ ok: true });
    }
    if (key === "pins/clear") {
      const sid = String(b.sid || "");
      if (b.all) this.sql.exec(`DELETE FROM pins`);
      else this.sql.exec(`DELETE FROM pins WHERE sid=?`, sid);
      this.sql.exec(`DELETE FROM sess WHERE role='student'` + (b.all ? "" : ` AND sid=?`), ...(b.all ? [] : [sid]));
      return J({ ok: true });
    }
    if (key === "pins/unlock") {
      this.sql.exec(`UPDATE pins SET fails=0, lock=0 WHERE sid=?`, String(b.sid || ""));
      return J({ ok: true });
    }
    if (key === "log") {
      const before = Number(url.searchParams.get("before")) || 1e15;
      const rows = this.sql.exec(`SELECT seq,ts,actor,summary,undone, LENGTH(inv) AS il FROM log WHERE seq < ? ORDER BY seq DESC LIMIT 60`, before).toArray();
      return J({ log: rows.map((r) => ({ seq: r.seq, ts: r.ts, actor: r.actor, summary: r.summary, undone: !!r.undone, canUndo: r.il > 2 && !r.undone })) });
    }
    if (key === "undo") {
      const r = this.sql.exec(`SELECT * FROM log WHERE seq=?`, Number(b.seq)).toArray()[0];
      if (!r || r.undone) return E(400, "되돌릴 수 없는 기록입니다.");
      const ops = JSON.parse(r.inv || "[]");
      if (!ops.length) return E(400, "되돌릴 내용이 없습니다.");
      if (this.data == null) this.data = {};
      const inv = applyOps(this.data, ops);
      this.save();
      this.sql.exec(`UPDATE log SET undone=1 WHERE seq=?`, r.seq);
      const seq = this.bump("선생님", `되돌리기: ${r.summary}`, ops, inv);
      this.broadcastOps(seq, ops, "");
      return J({ seq });
    }
    return E(404, "없는 주소입니다.");
  }
}

/* ===== 동기화 공통 코드: 서버와 화면이 똑같이 씁니다 ===== */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isIdArr = (a) => Array.isArray(a) && a.every((x) => isObj(x) && x.id != null);
const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

const isEmptyVal = (v) => v === undefined || v === null || v === false || v === 0 || v === "" ||
  Array.isArray(v) && v.every(isEmptyVal) || isObj(v) && Object.keys(v).length === 0;
// 새로 생긴 값: 빈 그릇과 기본값은 "없을 때만 만들기(ensure)"로 보내서
// 두 기기가 같은 주(week)를 동시에 처음 만들어도 서로의 입력을 덮어쓰지 않게 한다.
function emitNew(b, path, out) {
  if (isObj(b)) {
    out.push({ op: "ensure", path, value: {} });
    for (const k of Object.keys(b)) emitNew(b[k], path.concat(k), out);
    return;
  }
  if (Array.isArray(b) && b.length && isIdArr(b)) {
    out.push({ op: "ensure", path, value: [] });
    for (const x of b) out.push({ op: "aput", path, id: String(x.id), value: clone(x) });
    return;
  }
  if (Array.isArray(b) && b.length && b.length <= 31 && b.every((x) => x === null || typeof x !== "object")) {
    // 요일 칸 같은 짧은 배열은 빈 틀을 "없을 때만" 만들고, 값이 있는 칸만 따로 보낸다
    out.push({ op: "ensure", path, value: b.map((x) => typeof x === "number" ? 0 : typeof x === "string" ? "" : typeof x === "boolean" ? false : null) });
    b.forEach((x, i) => { if (!isEmptyVal(x)) out.push({ op: "set", path: path.concat(i), value: x }); });
    return;
  }
  if (isEmptyVal(b)) out.push({ op: "ensure", path, value: clone(b) });
  else out.push({ op: "set", path, value: clone(b) });
}
// 바뀐 부분만 골라 낸다. 배열 안의 {id} 항목은 id로 비교해서, 두 기기가 동시에 추가해도 겹치지 않는다.
function diffState(a, b, path = [], out = []) {
  if (a === b) return out;
  if (a === undefined) {
    emitNew(b, path, out);
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) if (!(k in b)) out.push({ op: "del", path: path.concat(k) });
    for (const k of Object.keys(b)) {
      if (!(k in a)) emitNew(b[k], path.concat(k), out);
      else diffState(a[k], b[k], path.concat(k), out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && isIdArr(a) && isIdArr(b) && (a.length || b.length)) {
    const am = new Map(a.map((x) => [String(x.id), x]));
    const bm = new Map(b.map((x) => [String(x.id), x]));
    for (const id of am.keys()) if (!bm.has(id)) out.push({ op: "adel", path, id });
    for (const x of b) {
      const id = String(x.id);
      if (!am.has(id)) out.push({ op: "aput", path, id, value: clone(x) });
      else if (!sameJSON(am.get(id), x)) diffState(am.get(id), x, path.concat({ i: id }), out);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && !isIdArr(a) && !isIdArr(b)) {
    // 요일 칸처럼 자리가 정해진 배열은 칸마다 따로 보낸다 (월요일·화요일을 다른 기기에서 동시에 고쳐도 둘 다 남음)
    for (let i = 0; i < b.length; i++) diffState(a[i], b[i], path.concat(i), out);
    return out;
  }
  if (!sameJSON(a, b)) out.push({ op: "set", path, value: clone(b) });
  return out;
}

const stepGet = (cur, st) => {
  if (cur == null) return undefined;
  if (isObj(st)) return Array.isArray(cur) ? cur.find((x) => isObj(x) && String(x.id) === String(st.i)) : undefined;
  return cur[st];
};
function getAt(root, path) {
  let cur = root;
  for (const st of path) {
    cur = stepGet(cur, st);
    if (cur === undefined) return undefined;
  }
  return cur;
}
// 경로의 부모까지 내려가며 없으면 만든다. 배열 id 항목이 없으면 null.
function parentOf(root, path) {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const st = path[i];
    let nx = stepGet(cur, st);
    if (nx === undefined || nx === null || typeof nx !== "object") {
      if (isObj(st)) return null;
      nx = isObj(path[i + 1]) ? [] : {};
      cur[st] = nx;
    }
    cur = nx;
  }
  return cur;
}
// 한 건을 적용하고, 되돌리기용 반대 작업을 돌려준다.
function applyOp(root, op) {
  const p = op.path || [];
  if (op.op === "aput" || op.op === "adel") {
    let arr = getAt(root, p);
    if (!Array.isArray(arr)) {
      if (op.op === "adel") return null;
      if (!p.length) return null;
      const par = parentOf(root, p);
      if (!par || isObj(p[p.length - 1])) return null;
      par[p[p.length - 1]] = arr = [];
    }
    const idx = arr.findIndex((x) => isObj(x) && String(x.id) === String(op.id));
    const prev = idx >= 0 ? clone(arr[idx]) : undefined;
    if (op.op === "aput") {
      if (idx >= 0) arr[idx] = clone(op.value);
      else arr.push(clone(op.value));
    } else if (idx >= 0) arr.splice(idx, 1);
    else return null;
    return prev === undefined ? { op: "adel", path: p, id: op.id } : { op: "aput", path: p, id: op.id, value: prev };
  }
  if (!p.length) return null;
  if (op.op === "ensure") {
    if (getAt(root, p) !== undefined) return null;
    const par0 = parentOf(root, p);
    const k = p[p.length - 1];
    if (!par0 || isObj(k) || Array.isArray(par0)) return null;
    par0[k] = clone(op.value);
    return { op: "del", path: p };
  }
  const last = p[p.length - 1];
  const par = parentOf(root, p);
  if (!par) return null;
  if (isObj(last)) {
    if (!Array.isArray(par)) return null;
    const idx = par.findIndex((x) => isObj(x) && String(x.id) === String(last.i));
    const prev = idx >= 0 ? clone(par[idx]) : undefined;
    if (op.op === "set") {
      if (idx >= 0) par[idx] = clone(op.value);
      else par.push(clone(op.value));
    } else if (idx >= 0) par.splice(idx, 1);
    const ap = p.slice(0, -1);
    return prev === undefined ? { op: "adel", path: ap, id: last.i } : { op: "aput", path: ap, id: last.i, value: prev };
  }
  const had = Object.prototype.hasOwnProperty.call(par, last);
  const prev = had ? clone(par[last]) : undefined;
  if (op.op === "set") par[last] = clone(op.value);
  else if (op.op === "del") {
    if (Array.isArray(par)) par.splice(Number(last), 1);
    else delete par[last];
  } else return null;
  return had ? { op: "set", path: p, value: prev } : { op: "del", path: p };
}
function applyOps(root, ops) {
  const inv = [];
  for (const op of ops) {
    const r = applyOp(root, op);
    if (r) inv.push(r);
  }
  return inv.reverse();
}

/* ===== 직업 권한: 서버와 화면이 같은 규칙을 씁니다 ===== */
const PERM_TABS = ["students", "laws", "present", "dili", "meal", "prize", "company", "tax", "bank", "bonds", "stocks", "pay"];
const NOJOB = "_none";
const PERM_DEFAULT = { students: "self" };
const PERM_DEFAULT_NOJOB = { students: "self", laws: "view", meal: "view", bonds: "view", stocks: "view" };
function permOfCore(data, jobId, tab) {
  if (tab === "roster") return "none";
  const v = (((data && data.perms) || {})[jobId] || {})[tab];
  if (v === "none" || v === "edit" || v === "view" || v === "self" && tab === "students" || v === "trade" && (tab === "bonds" || tab === "stocks")) return v;
  const d = jobId === NOJOB ? PERM_DEFAULT_NOJOB[tab] || "none" : PERM_DEFAULT[tab] || "view";
  return d;
}

/* ===== 캐릭터 상점 기본 가격 (화면의 상품 목록과 같아야 함) ===== */
const AV_PRICES = {"face_b0":0,"face_g0":0,"face_b1":0,"face_g1":0,"face_b2":0,"face_g2":0,"face_b3":0,"face_g3":0,"face_b4":0,"face_g4":0,"face_b5":0,"face_g5":0,"face_b6":0,"face_g6":0,"face_b7":0,"face_g7":0,"hair_b0":0,"hair_b1":80,"hair_b2":80,"hair_b3":80,"hair_b4":80,"hair_b5":80,"hair_b6":80,"hair_g0":0,"hair_g1":80,"hair_g2":80,"hair_g3":80,"hair_g4":80,"hair_g5":80,"hair_g6":80,"out_b_blazer":300,"out_b_vest":250,"out_b_hoodie":350,"out_b_wizard":600,"out_b_labcoat":300,"out_b_soccer":280,"out_b_explorer":400,"out_b_winter":350,"out_b_pumpkin":450,"out_b_angel":700,"out_g_blazer":300,"out_g_sweater":250,"out_g_bluedress":450,"out_g_pinkdress":450,"out_g_yellowdress":450,"out_g_wizard":600,"out_g_labcoat":300,"out_g_maid":400,"out_g_winter":350,"out_g_pumpkin":450,"out_g_angel":700,"shoe_sneaker_b":100,"shoe_boots_b":150,"shoe_sneaker2":100,"shoe_fur_b":160,"shoe_maryjane":120,"shoe_boots_g":150,"shoe_sneaker_g":100,"shoe_fur_g":160,"hat_cap":120,"hat_beanie":120,"hat_beret_b":150,"hat_aviator":200,"hat_wizard":250,"hat_crown":500,"acc_headphones":220,"acc_glasses":100,"acc_goggles":150,"acc_beltbag":150,"back_backpack":200,"hat_catears_b":150,"back_angelwings":500,"back_batwings":450,"hand_wand":300,"hand_sword":350,"hand_shield":300,"hat_redbow":100,"hat_bluebow":100,"hat_tiara":450,"hat_flowercrown":200,"hat_beret_g":150,"hat_sunhat":180,"hat_strawhat":160,"hat_catears_g":150,"hat_bunnyears":150,"hat_halo":400,"acc_necklace":250,"hand_bag":220,"hand_book":150,"hand_potion":250,"hand_lantern":200,"hand_bouquet":180,"pet_bunny":400,"pet_bear":400,"pet_cat":400,"fx_sparkle":200,"fx_stars":200,"fx_water":500,"fx_fire":500,"fx_magic":500};
const avPriceCore = (data, id) => {
  const p = (((data && data.shop) || {}).price || {})[id];
  return p != null && p !== "" && !isNaN(Number(p)) ? Math.max(0, Math.round(Number(p))) : AV_PRICES[id] || 0;
};

export { isObj, clone, diffState, getAt, applyOp, applyOps, permOfCore, PERM_TABS, NOJOB, AV_PRICES, avPriceCore };

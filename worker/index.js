const respond = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders } });
const error = (message, status = 400) => respond({ error: message }, status);
const dateRE = /^\d{4}-\d{2}-\d{2}$/;
const timeRE = /^([01]\d|2[0-3]):[0-5]\d$/;
const markTypes = new Set(["yellow", "red", "green"]);

function validDate(value) {
  if (typeof value !== "string" || !dateRE.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function addDays(value, days) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}
const SESSION_COOKIE = "__Host-ourdays";
const SESSION_AGE = 30 * 86400;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const randomHex = size => hex(crypto.getRandomValues(new Uint8Array(size)));
async function sha256(value) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function passwordHash(value, salt) {
  // workerd caps each PBKDF2 call at 100,000 rounds. Chain six independent
  // 100,000-round stages and tag the result so the format can be upgraded.
  let material = encoder.encode(value);
  for (let stage = 0; stage < 6; stage++) {
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    material = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(`${salt}:${stage}`), iterations: 100000 }, key, 256));
  }
  return `pbkdf2x6$${hex(material)}`;
}
function equalHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function identifier(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value.length > 254) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { value, kind: "email" };
  if (/^\+[1-9]\d{7,14}$/.test(value)) return { value, kind: "phone" };
  return null;
}
function validPassword(password) { return typeof password === "string" && password.length >= 10 && password.length <= 128; }
function cookieHeader(token, age = SESSION_AGE) { return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`; }
function cookieToken(request) {
  const part = (request.headers.get("cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(SESSION_COOKIE + "="));
  const token = part?.slice(SESSION_COOKIE.length + 1) || "";
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}
async function currentUser(db, request) {
  const token = cookieToken(request);
  if (!token) return null;
  return db.prepare("SELECT u.id,u.email,u.phone,u.name,u.cycle_length,u.couple_id,u.share_predictions,u.language FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN credentials c ON c.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND c.verified_at IS NOT NULL").bind(await sha256(token), Date.now()).first();
}
async function createSession(db, userId) {
  const token = randomHex(32), now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").bind(now),
    db.prepare("DELETE FROM auth_throttle WHERE expires_at<=?").bind(now)
  ]);
  await db.prepare("INSERT INTO auth_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)").bind(await sha256(token), userId, now + SESSION_AGE * 1000, now).run();
  return cookieHeader(token);
}
async function throttle(db, scope, value, limit, windowMs) {
  const key = await sha256(scope + ":" + value), now = Date.now();
  const row = await db.prepare("SELECT count,expires_at FROM auth_throttle WHERE key=?").bind(key).first();
  if (row && row.expires_at > now && row.count >= limit) throw Object.assign(new Error("尝试次数过多，请稍后再试"), { status: 429 });
  await db.prepare("INSERT INTO auth_throttle (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at>? THEN count+1 ELSE 1 END,expires_at=CASE WHEN expires_at>? THEN expires_at ELSE excluded.expires_at END").bind(key, now + windowMs, now, now).run();
}
async function clearThrottle(db, scope, value) {
  await db.prepare("DELETE FROM auth_throttle WHERE key=?").bind(await sha256(scope + ":" + value)).run();
}
function clientIp(request) { return request.headers.get("cf-connecting-ip") || "unknown"; }
function siteOrigin(request, env) { return env.PUBLIC_SITE_ORIGIN || new URL(request.url).origin; }
function emailAvailable(env) { return !!(env.RESEND_API_KEY && env.MAIL_FROM) || typeof env.__sendTestEmail === "function"; }
async function sendEmail(env, to, subject, text) {
  if (typeof env.__sendTestEmail === "function") return env.__sendTestEmail({ to, subject, text });
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw Object.assign(new Error("邮件服务尚未配置，暂时无法注册或发送找回邮件"), { status:503 });
  const response = await fetch("https://api.resend.com/emails", { method:"POST", headers:{ "authorization":"Bearer " + env.RESEND_API_KEY, "content-type":"application/json" }, body:JSON.stringify({ from:env.MAIL_FROM, to:[to], subject, text }) });
  if (!response.ok) throw Object.assign(new Error("验证邮件发送失败，请稍后重试"), { status:503 });
}
async function makeEmailToken(db, userId, purpose) {
  const token = randomHex(32), now = Date.now();
  await db.prepare("DELETE FROM email_tokens WHERE user_id=? AND purpose=?").bind(userId, purpose).run();
  await db.prepare("INSERT INTO email_tokens (token_hash,user_id,purpose,expires_at,created_at) VALUES (?,?,?,?,?)").bind(await sha256(token), userId, purpose, now + (purpose === "verify" ? 86400000 : 1800000), now).run();
  return token;
}
async function authAction(db, request, body, env) {
  const id = identifier(body.identifier), password = body.password;
  if (!id && body.action !== "reset_email") return error("请输入有效邮箱或带国家区号的手机号");
  const ip = clientIp(request);
  if (body.action === "register") {
    await throttle(db, "register-ip", ip, 8, 3600000);
    if (!!env.RESEND_API_KEY !== !!env.MAIL_FROM) return error("邮件服务配置不完整，请稍后再试", 503);
    const verifiedSignup = emailAvailable(env);
    if (verifiedSignup && id.kind !== "email") return error("新账号请使用邮箱注册；手机号注册需等短信验证开通");
    if (!validPassword(password)) return error("密码需为 10–128 个字符");
    const existing = await db.prepare("SELECT user_id,verified_at,created_at FROM credentials WHERE identifier=?").bind(id.value).first();
    if (existing && (existing.verified_at || existing.created_at > Date.now() - 86400000)) return error("此邮箱已注册或正在等待验证");
    if (existing) await db.batch([
      db.prepare("DELETE FROM email_tokens WHERE user_id=?").bind(existing.user_id),
      db.prepare("DELETE FROM credentials WHERE user_id=?").bind(existing.user_id),
      db.prepare("DELETE FROM users WHERE id=?").bind(existing.user_id)
    ]);
    const name = String(body.name || "").trim();
    if (!name || name.length > 30) return error("请填写 1–30 字的称呼");
    const userId = crypto.randomUUID(), salt = randomHex(16), recoverySalt = randomHex(16), recoveryCode = randomHex(16).toUpperCase(), now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO users (id,email,phone,name,cycle_length,created_at,language) VALUES (?,?,?,?,?,?,?)").bind(userId, id.kind === "email" ? id.value : "", id.kind === "phone" ? id.value : null, name, 28, now, ["zh","en","fr"].includes(body.language) ? body.language : "en"),
      db.prepare("INSERT INTO credentials (user_id,identifier,password_salt,password_hash,recovery_salt,recovery_hash,created_at,verified_at) VALUES (?,?,?,?,?,?,?,?)").bind(userId, id.value, salt, await passwordHash(password, salt), recoverySalt, await passwordHash(recoveryCode, recoverySalt), now, verifiedSignup ? null : now)
    ]);
    if (!verifiedSignup) {
      const user = await db.prepare("SELECT id,email,phone,name,cycle_length,couple_id,share_predictions,language FROM users WHERE id=?").bind(userId).first();
      return respond({ me:user, couple:null, partner:null, invite:null, recoveryCode }, 200, { "set-cookie":await createSession(db, userId) });
    }
    try {
      const token = await makeEmailToken(db, userId, "verify");
      await sendEmail(env, id.value, "验证你的两人日历账号", `请点击链接验证邮箱并开始使用两人日历：\n${siteOrigin(request, env)}/api/verify?token=${token}\n\n链接 24 小时内有效。如果不是你注册的账号，可以忽略此邮件。`);
    } catch (cause) {
      await db.batch([db.prepare("DELETE FROM email_tokens WHERE user_id=?").bind(userId),db.prepare("DELETE FROM credentials WHERE user_id=?").bind(userId),db.prepare("DELETE FROM users WHERE id=?").bind(userId)]);
      throw cause;
    }
    return respond({ pendingVerification:true, email:id.value });
  }
  if (body.action === "login") {
    await throttle(db, "login-ip", ip, 30, 900000);
    await throttle(db, "login-id", id.value, 6, 900000);
    const account = await db.prepare("SELECT user_id,password_salt,password_hash,verified_at FROM credentials WHERE identifier=?").bind(id.value).first();
    const candidate = validPassword(password) && account ? await passwordHash(password, account.password_salt) : "";
    if (!account || !equalHash(candidate, account.password_hash)) return error("账号或密码不正确", 401);
    if (!account.verified_at) return error("请先打开验证邮件中的链接；未收到邮件可在登录页重发", 403);
    await clearThrottle(db, "login-id", id.value);
    const user = await db.prepare("SELECT id,email,phone,name,cycle_length,couple_id,share_predictions,language FROM users WHERE id=?").bind(account.user_id).first();
    return respond({ me:user, ...await pairInfo(db, user) }, 200, { "set-cookie":await createSession(db, user.id) });
  }
  if (body.action === "resend_verification") {
    if (!emailAvailable(env)) return error("邮件服务尚未配置，请使用恢复码找回账号", 503);
    if (id.kind !== "email") return error("请输入邮箱地址");
    await throttle(db, "verify-ip", ip, 10, 3600000);
    await throttle(db, "verify-id", id.value, 3, 3600000);
    const account = await db.prepare("SELECT user_id FROM credentials WHERE identifier=? AND verified_at IS NULL").bind(id.value).first();
    if (account) {
      const token = await makeEmailToken(db, account.user_id, "verify");
      await sendEmail(env, id.value, "验证你的两人日历账号", `请点击链接验证邮箱：\n${siteOrigin(request, env)}/api/verify?token=${token}\n\n链接 24 小时内有效。`);
    }
    return respond({ ok:true, message:"如果账号尚未验证，邮件将发送到该邮箱" });
  }
  if (body.action === "request_reset") {
    if (!emailAvailable(env)) return error("邮件服务尚未配置，请使用恢复码找回账号", 503);
    if (id.kind !== "email") return error("邮箱找回只支持邮箱账号；原手机号账号请使用恢复码");
    await throttle(db, "reset-ip", ip, 10, 3600000);
    await throttle(db, "reset-id", id.value, 3, 3600000);
    const account = await db.prepare("SELECT user_id FROM credentials WHERE identifier=? AND contact_verified_at IS NOT NULL").bind(id.value).first();
    if (account) {
      const token = await makeEmailToken(db, account.user_id, "reset");
      await sendEmail(env, id.value, "重设你的两人日历密码", `请点击链接重设密码：\n${siteOrigin(request, env)}/?reset=${token}\n\n链接 30 分钟内有效。如果不是你发起的请求，可以忽略此邮件。`);
    }
    return respond({ ok:true, message:"如果该邮箱已注册，重设链接将发送到邮箱" });
  }
  if (body.action === "reset_email") {
    await throttle(db, "reset-token-ip", ip, 10, 3600000);
    if (!validPassword(body.newPassword)) return error("新密码需为 10–128 个字符");
    const token = String(body.token || "");
    if (!/^[0-9a-f]{64}$/.test(token)) return error("链接无效或已过期", 401);
    const row = await db.prepare("SELECT user_id FROM email_tokens WHERE token_hash=? AND purpose='reset' AND expires_at>?").bind(await sha256(token), Date.now()).first();
    if (!row) return error("链接无效或已过期", 401);
    const salt = randomHex(16), recoverySalt = randomHex(16);
    await db.batch([
      db.prepare("UPDATE credentials SET password_salt=?,password_hash=?,recovery_salt=?,recovery_hash=? WHERE user_id=?").bind(salt, await passwordHash(body.newPassword, salt), recoverySalt, await passwordHash(randomHex(32), recoverySalt), row.user_id),
      db.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(row.user_id),
      db.prepare("DELETE FROM email_tokens WHERE user_id=? AND purpose='reset'").bind(row.user_id)
    ]);
    const user = await db.prepare("SELECT id,email,phone,name,cycle_length,couple_id,share_predictions,language FROM users WHERE id=?").bind(row.user_id).first();
    return respond({ me:user, ...await pairInfo(db,user) }, 200, { "set-cookie":await createSession(db,user.id) });
  }
  if (body.action === "recover") {
    await throttle(db, "recover-ip", ip, 15, 900000);
    await throttle(db, "recover-id", id.value, 5, 900000);
    if (!validPassword(body.newPassword)) return error("新密码需为 10–128 个字符");
    const account = await db.prepare("SELECT user_id,recovery_salt,recovery_hash,verified_at FROM credentials WHERE identifier=?").bind(id.value).first();
    const code = String(body.recoveryCode || "").trim().toUpperCase();
    const candidate = account && /^[0-9A-F]{32}$/.test(code) ? await passwordHash(code, account.recovery_salt) : "";
    if (!account || !account.verified_at || !equalHash(candidate, account.recovery_hash)) return error("账号或恢复码不正确", 401);
    await clearThrottle(db, "recover-id", id.value);
    const salt = randomHex(16), recoverySalt = randomHex(16), recoveryCode = randomHex(16).toUpperCase();
    await db.batch([
      db.prepare("UPDATE credentials SET password_salt=?,password_hash=?,recovery_salt=?,recovery_hash=? WHERE user_id=?").bind(salt, await passwordHash(body.newPassword, salt), recoverySalt, await passwordHash(recoveryCode, recoverySalt), account.user_id),
      db.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(account.user_id),
      db.prepare("DELETE FROM email_tokens WHERE user_id=? AND purpose='reset'").bind(account.user_id)
    ]);
    const user = await db.prepare("SELECT id,email,phone,name,cycle_length,couple_id,share_predictions,language FROM users WHERE id=?").bind(account.user_id).first();
    return respond({ me:user, ...await pairInfo(db, user), recoveryCode }, 200, { "set-cookie":await createSession(db, user.id) });
  }
  return error("无效操作");
}
async function pairInfo(db, user) {
  if (!user.couple_id) return { couple: null, partner: null, invite: null };
  const pair = await db.prepare("SELECT id,invite_code,invite_expires FROM couples WHERE id=?").bind(user.couple_id).first();
  if (!pair) return { couple: null, partner: null, invite: null };
  const partner = await db.prepare("SELECT id,email,phone,name FROM users WHERE couple_id=? AND id<>?").bind(pair.id, user.id).first();
  return { couple: { id: pair.id }, partner, invite: partner || !pair.invite_code ? null : { code: pair.invite_code, expires: new Date(pair.invite_expires).toLocaleDateString("zh-CN") } };
}
async function pairing(db, user, body) {
  if (body.action === "create") {
    if (user.couple_id) return error("你已在双人空间中");
    const id = crypto.randomUUID(), code = inviteCode(), now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO couples (id,invite_code,invite_expires,created_at) VALUES (?,?,?,?)").bind(id, code, now + 7 * 86400000, now),
      db.prepare("UPDATE users SET couple_id=? WHERE id=? AND couple_id IS NULL").bind(id, user.id)
    ]);
    const me = await db.prepare("SELECT id,email,phone,name,cycle_length,couple_id,share_predictions,language FROM users WHERE id=?").bind(user.id).first();
    return respond({ me, ...await pairInfo(db, me) });
  }
  if (body.action === "join") {
    if (user.couple_id) return error("你已在双人空间中");
    const code = String(body.code || "").trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) return error("邀请码格式不正确");
    const pair = await db.prepare("SELECT id FROM couples WHERE invite_code=? AND invite_expires>?").bind(code, Date.now()).first();
    if (!pair) return error("邀请码不存在或已过期");
    const result = await db.prepare("UPDATE users SET couple_id=? WHERE id=? AND couple_id IS NULL AND (SELECT COUNT(*) FROM users WHERE couple_id=?)<2").bind(pair.id, user.id, pair.id).run();
    if (!result.meta.changes) return error("空间已有两位成员，或加入失败");
    await db.prepare("UPDATE couples SET invite_code=NULL,invite_expires=NULL WHERE id=?").bind(pair.id).run();
    const me = await db.prepare("SELECT id,email,phone,name,cycle_length,couple_id,share_predictions,language FROM users WHERE id=?").bind(user.id).first();
    return respond({ me, ...await pairInfo(db, me) });
  }
  if (body.action === "rotate") {
    if (!user.couple_id) return error("请先创建双人空间");
    const partner = await db.prepare("SELECT id FROM users WHERE couple_id=? AND id<>?").bind(user.couple_id, user.id).first();
    if (partner) return error("已经完成配对");
    const code = inviteCode(), expires = Date.now() + 7 * 86400000;
    await db.prepare("UPDATE couples SET invite_code=?,invite_expires=? WHERE id=?").bind(code, expires, user.couple_id).run();
    return respond({ invite: { code, expires: new Date(expires).toLocaleDateString("zh-CN") } });
  }
  return error("无效操作");
}
async function toggleMark(db, user, body) {
  if (!validDate(body.date) || !markTypes.has(body.type)) return error("日期或标记无效");
  const has = await db.prepare("SELECT visibility FROM marks WHERE user_id=? AND date=? AND type=?").bind(user.id, body.date, body.type).first();
  if (body.action === "visibility") {
    if (!has) return error("标记不存在", 404);
    if (body.visibility !== "private" && body.visibility !== "shared") return error("共享设置无效");
    if (body.visibility === "shared" && !user.couple_id) return error("请先与伴侣配对");
    await db.prepare("UPDATE marks SET visibility=? WHERE user_id=? AND date=? AND type=?").bind(body.visibility, user.id, body.date, body.type).run();
    return respond({ ok:true });
  }
  if (body.action && body.action !== "toggle") return error("无效操作");
  if (has) await db.prepare("DELETE FROM marks WHERE user_id=? AND date=? AND type=?").bind(user.id, body.date, body.type).run();
  else await db.prepare("INSERT INTO marks (user_id,couple_id,date,type,created_at,visibility) VALUES (?,?,?,?,?,?)").bind(user.id, user.couple_id, body.date, body.type, Date.now(), "private").run();
  return respond({ ok: true });
}
async function noteAction(db, user, body) {
  if (body.action === "delete") {
    await db.prepare("DELETE FROM notes WHERE id=? AND user_id=?").bind(String(body.id || ""), user.id).run();
    return respond({ ok: true });
  }
  if (body.action !== "create" && body.action !== "update") return error("无效操作");
  if (!validDate(body.date)) return error("日期无效");
  const content = String(body.content || "").trim(), start = body.startTime || null, end = body.endTime || null;
  const visibility = body.visibility === "shared" && user.couple_id ? "shared" : "private";
  if (!content || content.length > 5000) return error("备注需要填写内容，最多 5000 字");
  if ((start && !timeRE.test(start)) || (end && !timeRE.test(end)) || (end && start && end < start)) return error("时间格式无效");
  const now = Date.now();
  if (body.action === "create") await db.prepare("INSERT INTO notes (id,user_id,couple_id,date,start_time,end_time,content,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), user.id, user.couple_id, body.date, start, end, content, visibility, now, now).run();
  else {
    const result = await db.prepare("UPDATE notes SET date=?,start_time=?,end_time=?,content=?,visibility=?,couple_id=?,updated_at=? WHERE id=? AND user_id=?").bind(body.date, start, end, content, visibility, user.couple_id, now, String(body.id || ""), user.id).run();
    if (!result.meta.changes) return error("找不到可编辑的备注", 404);
  }
  return respond({ ok: true });
}
async function monthData(db, user, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return error("月份无效");
  const first = month + "-01";
  const weekday = (new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7;
  const from = addDays(first, -weekday), until = addDays(from, 42);
  const marks = (await db.prepare("SELECT user_id,date,type,visibility FROM marks WHERE (user_id=? OR (couple_id=? AND user_id<>? AND visibility='shared')) AND date>=? AND date<? ORDER BY date").bind(user.id, user.couple_id, user.id, from, until).all()).results;
  const notes = (await db.prepare("SELECT id,user_id,date,start_time,end_time,content,visibility,created_at,updated_at FROM notes WHERE (user_id=? OR (couple_id=? AND user_id<>? AND visibility='shared')) AND date>=? AND date<? ORDER BY date,start_time,created_at").bind(user.id, user.couple_id, user.id, from, until).all()).results;
  const red = (await db.prepare("SELECT m.user_id,m.date,u.name,u.cycle_length FROM marks m JOIN users u ON u.id=m.user_id WHERE (m.user_id=? OR (m.couple_id=? AND m.user_id<>? AND u.share_predictions=1)) AND m.type='red' AND m.date>=? AND m.date<? ORDER BY m.user_id,m.date").bind(user.id, user.couple_id, user.id, addDays(from, -420), until).all()).results;
  const starts = [];
  for (const row of red) {
    const last = starts.filter(x => x.user_id === row.user_id).at(-1);
    if (!last || row.date > addDays(last.last, 10)) starts.push({ ...row, last: row.date });
    else last.last = row.date;
  }
  const recent = [...new Map(starts.map(s => [s.user_id, s])).values()];
  const predictions = [];
  for (const s of recent) {
    const history = starts.filter(x => x.user_id === s.user_id);
    const gaps = [];
    for (let i = 1; i < history.length; i++) {
      const gap = Math.round((new Date(history[i].date) - new Date(history[i - 1].date)) / 86400000);
      if (gap >= 21 && gap <= 45) gaps.push(gap);
    }
    const cycle = gaps.length ? Math.round(gaps.slice(-6).reduce((a,b) => a+b,0) / Math.min(gaps.length,6)) : s.cycle_length;
    for (let n = 1; n <= 18; n++) {
      const periodStart = addDays(s.date, n * cycle), ovulation = addDays(periodStart, -14);
      const fertileStart = addDays(ovulation, -5), fertileEnd = addDays(ovulation, 1);
      if (periodStart >= from && periodStart < until || fertileEnd >= from && fertileStart < until) predictions.push({ user_id:s.user_id,name:s.name,periodStart,ovulation,fertileStart,fertileEnd,cycle });
    }
  }
  return respond({ marks, notes, predictions });
}

async function searchNotes(db, user, query) {
  const term = String(query || "").trim();
  if (!term || term.length > 100) return error("请输入 1–100 字的搜索词");
  const results = (await db.prepare("SELECT id,user_id,date,start_time,end_time,content,visibility FROM notes WHERE (user_id=? OR (couple_id=? AND user_id<>? AND visibility='shared')) AND instr(lower(content),lower(?))>0 ORDER BY date DESC,start_time DESC LIMIT 100").bind(user.id,user.couple_id,user.id,term).all()).results;
  return respond({ results });
}

async function exportData(db, user) {
  const marks = (await db.prepare("SELECT date,type,visibility,created_at FROM marks WHERE user_id=? ORDER BY date").bind(user.id).all()).results;
  const notes = (await db.prepare("SELECT date,start_time,end_time,content,visibility,created_at,updated_at FROM notes WHERE user_id=? ORDER BY date,start_time").bind(user.id).all()).results;
  const body = JSON.stringify({ exported_at: new Date().toISOString(), profile: { id:user.id,email:user.email,phone:user.phone,name:user.name,cycle_length:user.cycle_length,share_predictions:!!user.share_predictions,language:user.language }, marks, notes }, null, 2);
  return new Response(body, { headers: { "content-type":"application/json; charset=utf-8", "content-disposition":"attachment; filename=our-days-export.json", "cache-control":"no-store" } });
}

async function accountAction(db, user, body) {
  if (body.action !== "unlink" && body.action !== "delete") return error("无效操作");
  if (body.confirm !== (body.action === "delete" ? "删除账号" : "解除配对")) return error("请先输入确认文字");
  if (user.couple_id) await db.batch([
    db.prepare("UPDATE users SET couple_id=NULL,share_predictions=0 WHERE couple_id=?").bind(user.couple_id),
    db.prepare("UPDATE marks SET couple_id=NULL,visibility='private' WHERE couple_id=?").bind(user.couple_id),
    db.prepare("UPDATE notes SET couple_id=NULL,visibility='private' WHERE couple_id=?").bind(user.couple_id),
    db.prepare("DELETE FROM couples WHERE id=?").bind(user.couple_id)
  ]);
  if (body.action === "delete") await db.batch([
    db.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM email_tokens WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM credentials WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM notes WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM marks WHERE user_id=?").bind(user.id),
    db.prepare("DELETE FROM users WHERE id=?").bind(user.id)
  ]);
  return respond({ ok:true }, 200, body.action === "delete" ? { "set-cookie":cookieHeader("", 0) } : {});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options":"nosniff", "referrer-policy":"same-origin", "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" } });
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!env.DB) return error("数据库尚未连接", 503);
    if (request.method === "POST" && request.headers.get("origin") !== url.origin) return error("请求来源无效", 403);
    try {
      if (request.method === "GET" && url.pathname === "/api/config") return respond({ emailVerificationAvailable:emailAvailable(env) });
      if (request.method === "GET" && url.pathname === "/api/verify") {
        const token = url.searchParams.get("token") || "";
        if (!/^[0-9a-f]{64}$/.test(token)) return new Response(null, { status:302, headers:{ location:"/?verify=invalid", "cache-control":"no-store", "referrer-policy":"no-referrer" } });
        const row = await env.DB.prepare("SELECT user_id FROM email_tokens WHERE token_hash=? AND purpose='verify' AND expires_at>?").bind(await sha256(token),Date.now()).first();
        if (!row) return new Response(null, { status:302, headers:{ location:"/?verify=invalid", "cache-control":"no-store", "referrer-policy":"no-referrer" } });
        await env.DB.batch([
          env.DB.prepare("UPDATE credentials SET verified_at=?,contact_verified_at=? WHERE user_id=? AND verified_at IS NULL").bind(Date.now(),Date.now(),row.user_id),
          env.DB.prepare("DELETE FROM email_tokens WHERE user_id=? AND purpose='verify'").bind(row.user_id)
        ]);
        return new Response(null, { status:302, headers:{ location:"/?verified=1", "set-cookie":await createSession(env.DB,row.user_id), "cache-control":"no-store", "referrer-policy":"no-referrer" } });
      }
      if (request.method === "POST" && url.pathname === "/api/auth") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return error("请求内容无效");
        return await authAction(env.DB, request, body, env);
      }
      const user = await currentUser(env.DB, request);
      if (request.method === "POST" && url.pathname === "/api/logout") {
        const token = cookieToken(request);
        if (token) await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await sha256(token)).run();
        return respond({ ok:true }, 200, { "set-cookie":cookieHeader("", 0) });
      }
      if (!user) return error("请先登录或注册", 401);
      if (request.method === "GET" && url.pathname === "/api/me") return respond({ me: user, ...await pairInfo(env.DB, user) });
      if (request.method === "GET" && url.pathname === "/api/month") return monthData(env.DB, user, url.searchParams.get("month") || "");
      if (request.method === "GET" && url.pathname === "/api/search") return searchNotes(env.DB, user, url.searchParams.get("q"));
      if (request.method === "GET" && url.pathname === "/api/export") return exportData(env.DB, user);
      if (request.method !== "POST") return error("不支持此操作", 405);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return error("请求内容无效");
      if (url.pathname === "/api/pair") return pairing(env.DB, user, body);
      if (url.pathname === "/api/mark") return toggleMark(env.DB, user, body);
      if (url.pathname === "/api/note") return noteAction(env.DB, user, body);
      if (url.pathname === "/api/account") return accountAction(env.DB, user, body);
      if (url.pathname === "/api/profile") {
        const name = String(body.name || "").trim(), cycle = Number(body.cycleLength);
        if (!name || name.length > 30 || !Number.isInteger(cycle) || cycle < 21 || cycle > 45) return error("请填写名称，并将周期设置在 21–45 天之间");
        if (typeof body.sharePredictions !== "boolean") return error("预测共享设置无效");
        const sharePredictions = body.sharePredictions && !!user.couple_id ? 1 : 0;
        await env.DB.prepare("UPDATE users SET name=?,cycle_length=?,share_predictions=? WHERE id=?").bind(name, cycle, sharePredictions, user.id).run();
        return respond({ me: { ...user, name, cycle_length: cycle, share_predictions:sharePredictions } });
      }
      if (url.pathname === "/api/language") {
        if (!["zh", "en", "fr"].includes(body.language)) return error("语言设置无效");
        await env.DB.prepare("UPDATE users SET language=? WHERE id=?").bind(body.language, user.id).run();
        return respond({ language:body.language });
      }
      return error("找不到操作", 404);
    } catch (cause) {
      return error(cause.status ? cause.message : "服务暂时不可用，请稍后重试", cause.status || 500);
    }
  }
};

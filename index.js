const WEEK = 7 * 24 * 60 * 60 * 1000;
const GRADES = ["Kindergarten to 2nd grade", "3rd to 5th grade", "6th to 8th grade", "9th to 12th grade", "College"];
const HOURS = ["Less than 1 hour", "1 to 3 hours", "3 to 5 hours", "More than 5 hours"];
const MIN_GROUP = 5; // public impact page hides any breakdown smaller than this

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const validId = (v) => (typeof v === "string" && v.length >= 8 && v.length <= 64 ? v : null);
const same = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/survey" && request.method === "POST") return saveSurvey(request, env);
    if (pathname === "/api/progress" && request.method === "POST") return saveProgress(request, env);
    if (pathname === "/api/impact" && request.method === "GET") return impact(env);
    if (pathname === "/api/teacher" && request.method === "GET") return teacher(request, env);
    return env.ASSETS.fetch(request);
  },
};

async function saveSurvey(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = validId(b.studentId);
  const rating = int(b.rating, 1, 5), confidence = int(b.confidence, 1, 5), lessons = int(b.lessonsDone, 0, 18);
  if (!id || !rating || !confidence || lessons === null || !HOURS.includes(b.hours)) return json({ error: "Invalid survey" }, 400);
  const grade = GRADES.includes(b.grade) ? b.grade : "";

  const now = Date.now();
  const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM surveys WHERE student_id = ?").bind(id).first();
  if (last && last.t && now - last.t < WEEK) return json({ error: "Already submitted this week", nextAt: last.t + WEEK }, 429);

  await env.DB.prepare(
    "INSERT INTO surveys (student_id, grade, rating, confidence, hours, lessons_done, liked, change_note, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(id, grade, rating, confidence, b.hours, lessons, String(b.liked || "").slice(0, 500), String(b.change || "").slice(0, 500), now).run();
  return json({ ok: true, tokens: 10 });
}

// Called by the student's browser whenever lessons, name, grade or tokens change.
async function saveProgress(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const id = validId(b.studentId);
  if (!id) return json({ error: "Invalid student" }, 400);
  const name = String(b.name || "").trim().slice(0, 40);
  const grade = GRADES.includes(b.grade) ? b.grade : "";
  const done = {};
  if (b.done && typeof b.done === "object") {
    for (const k of Object.keys(b.done)) {
      if (/^[0-5]-[0-2]$/.test(k) && Number.isFinite(b.done[k])) done[k] = b.done[k];
    }
  }
  const tokens = int(b.tokens, 0, 100000) ?? 0;
  const redeemed = (Array.isArray(b.redeemed) ? b.redeemed : []).slice(0, 50).map((r) => ({
    name: String((r && r.name) || "").slice(0, 60), cost: int(r && r.cost, 0, 100000) ?? 0, when: Number.isFinite(r && r.when) ? r.when : 0,
  }));
  await env.DB.prepare(
    `INSERT INTO students (student_id, name, grade, lessons_done, done_json, tokens, redeemed, updated_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(student_id) DO UPDATE SET name = excluded.name, grade = excluded.grade, lessons_done = excluded.lessons_done,
       done_json = excluded.done_json, tokens = excluded.tokens, redeemed = excluded.redeemed, updated_at = excluded.updated_at`
  ).bind(id, name, grade, Object.keys(done).length, JSON.stringify(done), tokens, JSON.stringify(redeemed), Date.now()).run();
  return json({ ok: true });
}

// Teachers and donors: needs the ADMIN_KEY secret, sent in the X-Admin-Key header.
async function teacher(request, env) {
  const given = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY || !same(given, env.ADMIN_KEY)) return json({ error: "Unauthorized" }, 401);
  const students = await env.DB.prepare("SELECT * FROM students ORDER BY updated_at DESC").all();
  const surveys = await env.DB.prepare(
    "SELECT student_id, grade, rating, confidence, hours, lessons_done, liked, change_note, created_at FROM surveys ORDER BY created_at DESC LIMIT 2000"
  ).all();
  const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  return json({
    students: students.results.map((s) => ({
      id: s.student_id, name: s.name, grade: s.grade, lessons: s.lessons_done, done: parse(s.done_json, {}),
      tokens: s.tokens, redeemed: parse(s.redeemed, []), updated: s.updated_at,
    })),
    surveys: surveys.results,
  });
}

async function impact(env) {
  const db = env.DB;
  const t = await db.prepare("SELECT COUNT(*) AS surveys, COUNT(DISTINCT student_id) AS students, AVG(rating) AS rating, AVG(confidence) AS confidence, AVG(lessons_done) AS lessons FROM surveys").first();
  const hours = await db.prepare("SELECT hours, COUNT(*) AS n FROM surveys GROUP BY hours").all();
  const grades = await db.prepare("SELECT grade, COUNT(DISTINCT student_id) AS n FROM surveys WHERE grade != '' GROUP BY grade").all();
  const g = await db.prepare(
    `WITH r AS (SELECT student_id, confidence c,
        ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY created_at ASC) a,
        ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY created_at DESC) d FROM surveys)
     SELECT COUNT(DISTINCT student_id) AS n, AVG(CASE WHEN a = 1 THEN c END) AS first, AVG(CASE WHEN d = 1 THEN c END) AS latest
     FROM r WHERE student_id IN (SELECT student_id FROM surveys GROUP BY student_id HAVING COUNT(*) >= 2)`
  ).first();
  return json({
    students: t.students, surveys: t.surveys, rating: t.rating, confidence: t.confidence, lessons: t.lessons,
    hours: hours.results,
    grades: grades.results.filter((r) => r.n >= MIN_GROUP),
    growth: g && g.n >= MIN_GROUP ? { n: g.n, first: g.first, latest: g.latest } : null,
  });
}
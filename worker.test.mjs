/* AIの窓口のふるまい。Claude の偽物（fetch の差し替え）を使うので、外に出ず、
   料金もかかりません。
   実行： cd ai && npm install && node worker.test.mjs            */
import worker from "./worker.js";

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

const PATH = "/kn-7f3a9c1d4e8b2";
const KEY = "sk-ant-test-key";
const env0 = () => ({ AI_PATH: PATH, ANTHROPIC_API_KEY: KEY });

/* Claude の偽物。届いた頼みを控えておき、決めておいた返事を返します。 */
const sent = [];
let reply = null;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.method === "POST" ? JSON.parse(await req.text()) : null;
  sent.push({ url: req.url, method: req.method, headers: req.headers, body });
  const r = typeof reply === "function" ? reply(req, body) : reply;
  return new Response(JSON.stringify(r.body), {
    status: r.status || 200,
    headers: { "content-type": "application/json", "request-id": "req_test" },
  });
};
const message = (content, stop) => ({
  body: {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5",
    content, stop_reason: stop || "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  },
});

const call = (env, method, path, body, headers) =>
  worker.fetch(new Request("https://ai.test" + path, {
    method,
    headers: headers || (body === undefined ? undefined : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  }), env);

/* ---------- 合言葉 ---------- */
{
  sent.length = 0;
  const miss = await call(env0(), "POST", "/kn-wrong", { kind: "coach", question: "x" });
  check("道が違えば 404", miss.status === 404, String(miss.status));
  check("そのとき Claude は呼ばない", sent.length === 0);

  const noPath = await call({ ANTHROPIC_API_KEY: KEY }, "GET", PATH);
  check("AI_PATH が無ければ 500 で止まる", noPath.status === 500, String(noPath.status));
  check("そのとき理由を言う", /AI_PATH/.test((await noPath.json()).error));

  const shortPath = await call({ AI_PATH: "/abc", ANTHROPIC_API_KEY: KEY }, "GET", "/abc");
  check("短すぎる道は合言葉として認めない", shortPath.status === 500);

  const noKey = await call({ AI_PATH: PATH }, "GET", PATH);
  check("鍵が無ければ 500 で止まる", noKey.status === 500);
  check("そのとき理由を言う（鍵）", /ANTHROPIC_API_KEY/.test((await noKey.json()).error));
  check("鍵が無いときも Claude は呼ばない", sent.length === 0);
}

/* ---------- ブラウザの事前問い合わせ ---------- */
{
  const pre = await call(env0(), "OPTIONS", PATH, undefined, {
    Origin: "https://example.github.io",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  });
  check("OPTIONS は 204", pre.status === 204, String(pre.status));
  check("Content-Type を付けてよいと答える",
    /content-type/i.test(pre.headers.get("access-control-allow-headers") || ""));
  check("POST を許す", /POST/.test(pre.headers.get("access-control-allow-methods") || ""));
}

/* ---------- 確かめる（料金のかからない一往復） ---------- */
{
  sent.length = 0;
  reply = { body: { id: "claude-opus-5", type: "model", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" } };
  const res = await call(env0(), "GET", PATH);
  const out = await res.json();
  check("GET は 200", res.status === 200, String(res.status));
  check("GET は ok と窓口の印を返す", out.ok === true && out.kind === "kurashi-ai", JSON.stringify(out));
  check("GET はモデルを引くだけ（文章を作らない）",
    sent.length === 1 && sent[0].method === "GET" && /\/v1\/models\/claude-opus-5$/.test(sent[0].url), sent[0] && sent[0].url);
  check("鍵を x-api-key で渡す", sent[0].headers.get("x-api-key") === KEY);
  check("GET の返事に鍵が写らない", !JSON.stringify(out).includes(KEY));

  reply = { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
  const bad = await call(env0(), "GET", PATH);
  check("鍵が違えば 502", bad.status === 502, String(bad.status));
  check("そのとき鍵を見直すよう言う", /鍵が通りません/.test((await bad.json()).error));
}

/* ---------- 相談 ---------- */
{
  sent.length = 0;
  reply = message([
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "この2週間は、" },
    { type: "text", text: "歩いた日ほど体重の7日平均が下がっています。" },
  ]);
  const data = { today: "2026-09-27", days: [{ day: "2026-09-26", weightKg: 60.2 }] };
  const res = await call(env0(), "POST", PATH, { kind: "coach", question: "最近どう？", data });
  const out = await res.json();
  check("相談は 200", res.status === 200, String(res.status));
  check("文章だけをつないで返す（考えた跡は入れない）",
    out.text === "この2週間は、歩いた日ほど体重の7日平均が下がっています。", out.text);

  const b = sent[0].body;
  check("モデルは claude-opus-5", b.model === "claude-opus-5", b.model);
  check("断られたら答え直させる（fallbacks: default）", b.fallbacks === "default");
  check("答え直しの beta を名乗る",
    /server-side-fallback-2026-07-01/.test(sent[0].headers.get("anthropic-beta") || ""));
  check("本人の記録を渡す", b.messages[0].content[0].text.includes('"weightKg":60.2'));
  check("相談の文を渡す", b.messages[0].content[1].text.includes("最近どう？"));
  check("相関を因果と言わせない一言が system にある", /相関を因果と断定しない/.test(b.system));

  sent.length = 0;
  const empty = await call(env0(), "POST", PATH, { kind: "coach", question: "  ", data });
  check("空の相談は 400", empty.status === 400);
  check("空の相談で Claude は呼ばない", sent.length === 0);

  reply = message([], "refusal");
  const refused = await call(env0(), "POST", PATH, { kind: "coach", question: "x", data });
  const r = await refused.json();
  check("断られたら、そう言う（200 で文を返す）", refused.status === 200 && /答えられませんでした/.test(r.text), r.text);
}

/* ---------- 写真 ---------- */
{
  const image = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD=";
  sent.length = 0;
  reply = message([{ type: "text", text: JSON.stringify({
    items: [{ name: "ご飯", grams: 180, kcal: 281, p: 4.5, f: 0.5, c: 66.8 },
            { name: "味噌汁", grams: null, kcal: 40, p: 3, f: 1.2, c: 4 }],
    note: "茶碗は並の大きさと見ました",
  }) }]);
  const res = await call(env0(), "POST", PATH, { kind: "photo", image, hint: "朝ごはん" });
  const out = await res.json();
  check("写真は 200", res.status === 200, String(res.status));
  check("品目をそのまま返す", out.items.length === 2 && out.items[0].name === "ご飯" && out.items[1].grams === null,
    JSON.stringify(out.items));
  check("前提の一言を返す", out.note === "茶碗は並の大きさと見ました");

  const b = sent[0].body;
  const img = b.messages[0].content[0];
  check("写真を base64 の画像として渡す",
    img.type === "image" && img.source.type === "base64" && img.source.media_type === "image/jpeg"
    && img.source.data === "/9j/4AAQSkZJRgABAQAAAQABAAD=");
  check("添え書きを渡す", b.messages[0].content[1].text.includes("朝ごはん"));
  check("返事の形を JSON の型で縛る",
    b.output_config.format.type === "json_schema"
    && b.output_config.format.schema.required.join(",") === "items,note");
  check("写真でも断られたら答え直させる", b.fallbacks === "default");

  sent.length = 0;
  const bad = await call(env0(), "POST", PATH, { kind: "photo", image: "https://example.com/a.jpg" });
  check("data URL でない写真は 400", bad.status === 400);
  check("読めない写真で Claude は呼ばない", sent.length === 0);

  reply = message([], "refusal");
  const refused = await (await call(env0(), "POST", PATH, { kind: "photo", image })).json();
  check("断られたら、数を作らず空で返す", Array.isArray(refused.items) && refused.items.length === 0 && refused.note);

  reply = message([{ type: "text", text: '{"items":[{"name":"ご' }], "max_tokens");
  const cut = await (await call(env0(), "POST", PATH, { kind: "photo", image })).json();
  check("途中で切れたら、数を作らず空で返す", cut.items.length === 0 && /切れました/.test(cut.note), cut.note);
}

/* ---------- 形の違う頼み ---------- */
{
  sent.length = 0;
  const notJson = await call(env0(), "POST", PATH, "kind=coach", { "Content-Type": "application/json" });
  check("JSON でなければ 400", notJson.status === 400);
  const unknown = await call(env0(), "POST", PATH, { kind: "diary" });
  check("知らない kind は 400", unknown.status === 400);
  const big = await call(env0(), "POST", PATH, "x".repeat(6 * 1024 * 1024 + 1), { "Content-Type": "application/json" });
  check("大きすぎれば 413", big.status === 413, String(big.status));
  check("形の違う頼みで Claude は呼ばない", sent.length === 0);
  const put = await call(env0(), "PUT", PATH, { kind: "coach" });
  check("GET・POST 以外は 405", put.status === 405);

  reply = { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } };
  const busy = await call(env0(), "POST", PATH, { kind: "coach", question: "x", data: {} });
  check("混雑は 429 で返す", busy.status === 429, String(busy.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

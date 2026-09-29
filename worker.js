/* =========================================================
   くらしノート — AIの窓口（Cloudflare Worker）
   =========================================================

   アプリの「AIの窓口」に貼るURLの、向こう側です。APIキーはここに置き、
   ここが Claude を呼びます。アプリ（js/diet-ai.js）との約束はこれだけです。

     GET  <URL>   確かめる。鍵が通るか・モデルが使えるかを見るだけで、
                  文章は作りません（料金はかかりません）
     POST <URL>   { "kind": "coach", "question": "…", "data": { … } }
                    → { "text": "…" }
                  { "kind": "photo", "image": "data:image/jpeg;base64,…", "hint": "…" }
                    → { "items": [ { "name", "grams", "kcal", "p", "f", "c" } ], "note": "…" }

   しくじったときは { "error": "…" } を、4xx / 5xx で返します。アプリは
   その文をそのまま画面に出します。

   ---- 鍵をアプリに置かない理由 ----

   アプリは誰でも中身を読める静的なページです。鍵を埋めるのは、鍵を
   玄関マットの下に置いて出かけるのと同じです。鍵は Cloudflare の
   **Secret**（ANTHROPIC_API_KEY）に置きます。

   ---- URLの道そのものが合言葉 ----

   中継所（relay/）と同じです。この窓口を知っている人は、あなたの鍵で
   Claude を呼べます——料金もあなたに来ます。だから当てられない長い道
   （AI_PATH）を合言葉にして、道が違えば何も言わずに 404 を返します。
   それでも漏れたときのために、**Anthropic の Console で月の上限額を
   決めておいてください**（ai/README.md の「気にしておくこと」）。

   ---- 何を残すか ----

   何も残しません。受け取った記録や写真は、Claude に渡して、返事を返したら
   それで終わりです。置き場（KV）も持ちません。wrangler.jsonc で
   observability も切ってあるので、Cloudflare の記録にも本文は残りません。

   建て方は ai/README.md にあります。 */

import Anthropic from "@anthropic-ai/sdk";

/* モデル。写真の推定も相談も、同じ一つで答えます。 */
const MODEL = "claude-opus-5";

/* 考える深さ。アプリは相談を45秒、写真を60秒で待ちきります（js/diet-ai.js）。
   いちばん深い既定（high）では、30日ぶんの記録を読んだ相談がそこへ届き
   かねないので、一段浅くして待ち時間の内に収めています。 */
const EFFORT = "medium";

/* 受け取る大きさの上限。写真はアプリが長い辺1024pxのJPEGに縮めてから
   送るので、base64 にしても数百KBです。相談の記録（30日ぶん）は数十KB。
   桁で余裕を見ています。 */
const MAX_BODY = 6 * 1024 * 1024;
const MAX_QUESTION = 2000;
const MAX_HINT = 500;

/* アプリのページから呼べるようにするための約束。POST に Content-Type:
   application/json を付けるので、ブラウザが先に OPTIONS を投げてきます。
   その問い合わせに「Content-Type は付けてよい」と答えるのが Allow-Headers です。 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* 断られたとき（安全のための判断で答えが止まったとき）に、同じ頼みを
   別のモデルで答え直させる仕掛け。Anthropic が断られた理由に合った
   モデルを選びます。 */
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

const COACH_SYSTEM = [
  "あなたは、くらしノートというアプリの中で、本人の体重・食事・歩数・睡眠・お酒の記録を読んで相談に答える相手です。",
  "一般論ではなく、渡された本人の記録に基づいて答えてください。記録に無いことは推測で埋めず「記録からはわかりません」と言ってください。",
  "相関を因果と断定しないでください。件数が少ないうちは、傾向として語らないでください。",
  "estimated が真の値は推定値です。細かい差を意味のあるものとして扱わないでください。",
  "体重は量った条件（食前・食後、着衣の有無）で動きます。条件の違う日どうしの差を、体の変化として読まないでください。",
  "病気の診断や薬の判断はしないでください。体調の心配があるときは、医師に相談するよう勧めてください。",
  "責めたり、励ましで押したりしないでください。数字を採点しないでください。",
  "日本語で、短く答えてください。見出しや表は使わず、数行の文章で。",
].join("\n");

const PHOTO_SYSTEM = [
  "食事の写真から、写っている料理・食品ごとに、量（グラム）とエネルギー・三大栄養素を推定します。",
  "name は日本語の短い料理名・食品名にしてください（例：ご飯、味噌汁、鶏の唐揚げ）。",
  "grams は可食部の重さの推定です。見当がつかなければ null にしてください。",
  "kcal はキロカロリー、p はたんぱく質、f は脂質、c は炭水化物で、どれもグラムです。",
  "飲み物・調味料も、量が意味を持つものは一品として数えてください。",
  "食べ物が写っていなければ、items を空にして、note にそう書いてください。",
  "note には、推定の前提（器の大きさの見立て、見えない具など）を一、二文で書いてください。",
].join("\n");

/* 写真の返事の形。この型に合う JSON しか返ってこないように、Claude の
   側で縛ります（structured outputs）。 */
const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          grams: { anyOf: [{ type: "number" }, { type: "null" }] },
          kcal: { type: "number" },
          p: { type: "number" },
          f: { type: "number" },
          c: { type: "number" },
        },
        required: ["name", "grams", "kcal", "p", "f", "c"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["items", "note"],
  additionalProperties: false,
};

const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
const fail = (status, error) => json({ error }, status);

/** 返ってきた本文から、文章のところだけを拾います（考えた跡や、答え直しの印は飛ばします）。 */
function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/* Claude の側でしくじったときに、アプリへ返す一言。鍵の間違い・混雑・
   残高切れは、どれも**アプリを直しても治らない**ので、何を見ればいいかを
   言います。 */
function apiFailure(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return fail(502, "鍵が通りませんでした（ANTHROPIC_API_KEY を確かめてください）");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return fail(502, "この鍵では、このモデルを使えません");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return fail(429, "混み合っています。少し待ってからもう一度");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return fail(502, `Claude が頼みを受け付けませんでした：${err.message}`);
  }
  if (err instanceof Anthropic.APIError && err.status) {
    return fail(502, `Claude が ${err.status} を返しました`);
  }
  return fail(502, "Claude に届きませんでした");
}

async function coach(client, body) {
  const question = String(body.question || "").trim().slice(0, MAX_QUESTION);
  if (!question) return fail(400, "質問が空です");
  const data = body.data && typeof body.data === "object" ? body.data : {};

  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: EFFORT },
    system: COACH_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "本人の記録（JSON）:\n" + JSON.stringify(data) },
        { type: "text", text: "相談:\n" + question },
      ],
    }],
  });

  if (message.stop_reason === "refusal") {
    return json({ text: "この相談には答えられませんでした。聞き方を変えてみてください。" });
  }
  return json({ text: textOf(message) });
}

async function photo(client, body) {
  const m = IMAGE_RE.exec(String(body.image || ""));
  if (!m) return fail(400, "写真の形が読めません（JPEG・PNG・WebP・GIF の data URL）");
  const hint = String(body.hint || "").trim().slice(0, MAX_HINT);

  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: PHOTO_SCHEMA },
    },
    system: PHOTO_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: hint ? "添え書き：" + hint : "この食事を推定してください。" },
      ],
    }],
  });

  /* 断られたとき・書ききれずに止まったときは、型どおりの JSON が来るとは
     限りません。数を作らずに「読み取れなかった」と返します——あやしい
     数が記録に入るより、空のほうがましです。 */
  if (message.stop_reason === "refusal") {
    return json({ items: [], note: "この写真は推定できませんでした" });
  }
  if (message.stop_reason === "max_tokens") {
    return json({ items: [], note: "推定が途中で切れました。もう一度試してください" });
  }
  let out;
  try { out = JSON.parse(textOf(message)); }
  catch (err) { return json({ items: [], note: "推定を読み取れませんでした" }); }
  const items = Array.isArray(out.items) ? out.items : [];
  return json({ items, note: String(out.note || "") });
}

/* 確かめる。モデルの一覧を一件引くだけなので、文章を作る料金はかかりません。
   通れば、鍵が正しく、そのモデルがこの鍵で使えるということです。 */
async function check(client) {
  const model = await client.models.retrieve(MODEL);
  return json({ ok: true, kind: "kurashi-ai", model: model.id });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    /* 道が違えば、それ以上何も言いません。AI_PATH を置き忘れたまま公開すると
       「合言葉なし」の窓口になり、誰でもあなたの鍵を使えてしまうので、
       未設定は 404 ではなく、はっきり止めます。 */
    if (!env.AI_PATH || !/^\/\S{8,}$/.test(env.AI_PATH)) {
      return fail(500, "AI_PATH が設定されていません（Settings → Variables and Secrets に Secret で置いてください）");
    }
    if (url.pathname !== env.AI_PATH) {
      return new Response("not found", { status: 404, headers: CORS });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return fail(500, "ANTHROPIC_API_KEY が設定されていません（Settings → Variables and Secrets に Secret で置いてください）");
    }

    /* アプリは60秒で待ちきるので、それより長く粘っても誰も受け取りません。
       混雑のときの答え直しも一度だけにします。 */
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60 * 1000, maxRetries: 1 });

    try {
      if (request.method === "GET") return await check(client);
      if (request.method !== "POST") return fail(405, "GET か POST で呼んでください");

      const size = Number(request.headers.get("Content-Length") || 0);
      if (size > MAX_BODY) return fail(413, "大きすぎます");
      const raw = await request.text();
      if (raw.length > MAX_BODY) return fail(413, "大きすぎます");
      let body;
      try { body = JSON.parse(raw); }
      catch (err) { return fail(400, "JSON として読めません"); }

      if (body && body.kind === "coach") return await coach(client, body);
      if (body && body.kind === "photo") return await photo(client, body);
      return fail(400, "kind は coach か photo です");
    } catch (err) {
      return apiFailure(err);
    }
  },
};

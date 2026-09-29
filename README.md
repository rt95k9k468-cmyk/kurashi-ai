# AIの窓口

くらしノートの **設定 → ダイエット → AIの窓口** に貼るURLの、向こう側の見本です。
これを置くと、**食事の写真からの推定**と**AI相談**が、アプリの中で使えるようになります。

## なぜ窓口が要るのか

Claude を呼ぶには APIキー（鍵）が要ります。でもアプリは誰でも中身を読める静的な
ページなので、鍵を埋めるのは、鍵を玄関マットの下に置いて出かけるのと同じです。

だから鍵は **Cloudflare の Worker（窓口）** に置き、アプリは窓口のURLだけを持ちます。
アプリ → 窓口 → Claude → 窓口 → アプリ、の一周です。

- 送るのは**ダイエットの記録**（相談のとき）と、**食事の写真**（推定のとき）だけです。
  買うもの・やること・日記は送りません
- 窓口は**何も残しません**。置き場（KV）を持たず、Cloudflare の記録（observability）も
  切ってあります

## どこにあるか

```
rt95k9k468-cmyk/kaimono-note      （公開・ブランチ main）
└── ai/
    ├── wrangler.jsonc        設計図（名前は kurashi-ai）
    ├── worker.js             窓口の本体
    ├── .dev.vars.example     配置のときに AI_PATH と ANTHROPIC_API_KEY を尋ねさせるため
    ├── package.json          Claude の公式 SDK（@anthropic-ai/sdk）を使います
    ├── worker.test.mjs       ふるまいのテスト（外に出ません・料金もかかりません）
    └── README.md             これ
```

## 建て方（iPhoneだけ・パソコン不要）

**手順はアプリの中にもあります**（設定 → ダイエット → AIの窓口）。中継所（relay/）と
同じ三段です。

### 0. 鍵をつくる

[Anthropic の Console](https://console.anthropic.com) に登録して、**API Keys** で鍵
（`sk-ant-…`）を作ります。このとき **Limits で月の上限額**も決めておいてください
（下の「気にしておくこと」）。鍵はこのあと一度貼るだけなので、メモに残さなくて構いません。

### ① 道（合言葉）をつくる

アプリの **「道をつくる」** を押します。`/kn-…` が出て、クリップボードに乗ります。
中継所の道とは**別のもの**にしてください（片方が漏れても、もう片方が無事なように）。

### ② 窓口を置く

アプリの **「Cloudflareに置く」** を押すと、この `ai/` を指した配置画面が開きます。

1. Cloudflareに登録して、GitHubとつなぐ画面が出たら許可する
2. **AI_PATH** を聞かれたら、①でコピーした道を**ペースト**
3. **ANTHROPIC_API_KEY** を聞かれたら、0 で作った鍵を**ペースト**
4. **Deploy**

ボタンの行き先はこれです（手で開くなら）:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/rt95k9k468-cmyk/kaimono-note/tree/main/ai
```

**聞かれなかったら**、置いたあとに **Settings → Variables and Secrets → Add** で、
Type を **Secret** にして `AI_PATH` と `ANTHROPIC_API_KEY` を置き、**Deploy** し直して
ください。置く画面が出なければ、**Create → Import a repository → kaimono-note** を選び、
**Root directory** に `ai` と入れて配置します。

### ③ URLをつなげる

Worker の画面に出ている `…workers.dev` をコピーして、アプリの **窓口のURL** に貼り、
**「保存」**。①の道が後ろに付きます。**「確かめる」** で「通りました」と出れば完了です。

「確かめる」は、鍵でモデルの情報を一件引くだけです。文章は作らないので、料金は
かかりません。

## パソコンがある場合

```sh
cd ai
npm install
npx wrangler secret put AI_PATH            # アプリの「道をつくる」で作った道
npx wrangler secret put ANTHROPIC_API_KEY  # sk-ant-…
npx wrangler deploy
```

## コードのほうのテスト

```sh
cd ai && npm install && node worker.test.mjs      # → 46 passed
```

Claude の偽物（fetch の差し替え）を使うので、外に出ず、料金もかかりません。

## アプリとの約束

```
GET  <URL>   → { "ok": true, "kind": "kurashi-ai", "model": "claude-opus-5" }

POST <URL>   Content-Type: application/json
  ① 相談  { "kind":"coach", "question":"…", "data":{ …本人の記録… } }
          → { "text": "…" }
  ② 写真  { "kind":"photo", "image":"data:image/jpeg;base64,…", "hint":"…" }
          → { "items":[ {"name":"ご飯","grams":180,"kcal":281,"p":4.5,"f":0.5,"c":66.8} ],
              "note":"…" }

しくじったとき → 4xx / 5xx と { "error": "…" }（アプリはこの文を画面に出します）
```

- モデルは `claude-opus-5`。考える深さ（effort）は一段浅い `medium` にしてあります——
  アプリは相談を45秒、写真を60秒で待ちきるので、その内に収めるためです
- 写真の返事は、JSON の型で縛って返させます（structured outputs）。型どおりの返事しか
  来ないので、数の読み違いが起きません
- 安全のための判断で断られたときは、Anthropic が選んだ別のモデルで答え直させます
  （`fallbacks: "default"`）。それでも断られたら、写真なら**数を作らずに空で**返します
  （「何も読み取れませんでした」）——あやしい数が記録に入るより、空のほうがましです
- 写真から返る数は**推定**です。アプリは `推定` の印を付けて保存し、画面でも「約」と書きます

## 気にしておくこと

- **URLが鍵です。** 知っている人は、あなたの鍵で Claude を呼べます——料金もあなたに
  来ます。スクリーンショットに写り込ませないでください
- **Console の Limits で、月の上限額を決めておいてください。** URLが漏れても、そこで
  止まります。目安は、写真一枚で数円、相談一回で十円前後です（測ってはいません。
  写真の大きさ・記録の量・考えた長さで動きます）
- 漏れたと思ったら、アプリで新しい道を作り、Cloudflare の **Settings → Variables and
  Secrets** で `AI_PATH` を差し替えて **Deploy**、アプリの窓口のURLも入れ直します
  （それだけで古いURLは死にます）。鍵そのものが漏れたなら、Console で鍵を消して作り直し、
  `ANTHROPIC_API_KEY` を差し替えます

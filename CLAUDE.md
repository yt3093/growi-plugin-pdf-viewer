# CLAUDE.md

## プロジェクト概要

- **名前**: `growi-plugin-pdf-viewer`
- **種別**: GROWI Script プラグイン
- **目的**: GROWI ページ本文中の PDF 添付ファイルへのリンクを検出し、ダウンロード/別タブ遷移ではなく
  **ページ内インラインで pdf.js ビューアとして展開表示**する

### 実装済み機能

| 機能 | 説明 |
|---|---|
| リンク検出 | `href` が `/attachment/` から始まり、かつリンクテキスト（ファイル名）が `.pdf` で終わる `<a>` のみを対象にする |
| トグル UI | 対象リンクにアイコン＋「PDFを表示」ボタンを付与。押すとリンク直後にビューアを展開、再度押すと閉じる |
| インライン展開 | モーダルではなく本文の流れの中にビューアを挿入する方式 |
| 遅延描画 | 全ページ分のプレースホルダーを先に並べ、`IntersectionObserver` で可視ページに近づいたものだけ canvas 描画する |
| ズーム | ツールバーのボタンで拡大/縮小。プレースホルダー高さと描画済みページを再計算・再描画する |
| ページジャンプ | ページ番号を入力してそのページへ `scrollIntoView` |
| ダウンロード | ツールバーに元の添付 URL への `download` リンクを設置 |
| テキスト選択・コピー | pdf.js の `TextLayer` を canvas に重ねて配置し、文字選択・コピーを可能にする |
| 複数同時展開 | 同一ページ内の複数 PDF リンクは、それぞれ独立してビューアを持ち同時展開できる |
| ツールバー内クローズボタン | `.gpv-toolbar` は `position: sticky` で追従するため、外側の「PDFを表示/閉じる」トグルがスクロールで画面外に出た後でも、ツールバー右端の ✕ ボタンから閉じられる。押すと `onRequestClose` 経由で外側トグルの表示（テキスト/`aria-expanded`）も同期する |
| ページ読み込みスピナー | 未描画のページプレースホルダーに回転スピナーを表示し、`renderPage()` が最初に呼ばれた時点（canvas 挿入時）で消える。`prefers-reduced-motion: reduce` では回転を止める |
| CORS フォールバック | pdf.js の `fetch` が失敗（CORS 等）した場合、`<iframe src="元のURL">` によるブラウザ標準 PDF 表示にフォールバックする。ズーム/ページジャンプ/テキスト選択は使えないが「見られない」状態は回避する |
| DOM 復元 | `unmount()` 時にアイコン・トグルボタン・enhanced マーカー・付与クラスを全て除去し元の `<a>` に戻す |
| SPA 遷移 | `pushState` / `replaceState` モンキーパッチ + `popstate` + `hashchange` で再スキャン（フルスキャン） |
| 動的追加対応 | `MutationObserver` で `<a>` 追加を検知し、変更があった部分木だけを対象にスコープされた再スキャンを行う |
| エディタ DOM 除外 | `.CodeMirror` / `.cm-editor` / `[contenteditable="true"]` 配下の要素は対象外 |
| 非実行条件 | 編集モード（`/edit`, `#edit`, `body.editing`, `body.grw-editor-mode`, `body.modal-open`）・管理画面（`/admin`）では実行しない |
| ダークモード | `@media (prefers-color-scheme: dark)` と `html[data-bs-theme="dark"]`（Bootstrap 5.3 GROWI UI トグル）の双方で配色を切り替える（2 箇所は値を同期させること） |
| 印刷対応 | `@media print` でツールバー等の操作 UI を非表示にする |

## アーキテクチャ

このプラグインは Markdown レンダリングの拡張ではなく **DOM 直接操作** を行う。`activate()` 内で既存の `<a>` を
スキャンしてトグル UI を付与し、トグル押下で初めて `createInlineViewer()` を mount する（初回クリック時マウント）。
`MutationObserver` で動的追加にも追従する。

**ブランチ運用方針**: 機能ごとに git ブランチを分けて実装・確認し、マージする。

### ファイル構成

```
growi-plugin-pdf-viewer/
├── client-entry.tsx                        # activate / deactivate + pluginActivators 登録
├── src/
│   ├── pdfViewer.ts                        # コア実装（スキャン・トグル付与・SPA遷移・MutationObserver・cleanup）
│   ├── inlineViewer.ts                     # 1リンク分のインラインビューア（expand/collapse・遅延描画・zoom・ページジャンプ・text layer）
│   ├── types.ts                            # 共有型定義（PdfViewerHandle / InlineViewerHandle 等）+ Window.pluginActivators のグローバル型拡張
│   └── styles/pdfViewer.css               # ビューア/ツールバー/text layer スタイル・ダークモード・@media print
├── package.json
├── tsconfig.json / tsconfig.node.json      # tsconfig.json の compilerOptions.types に "vite/client" が必須（後述）
├── vite.config.ts                          # build.manifest: 'manifest.json'、worker: { format: 'es' } を明示
├── pnpm-lock.yaml
└── dist/                                   # ビルド成果物（コミット必須）
    ├── manifest.json
    └── assets/
        ├── client-entry-*.js               # pdf.js 本体・worker を含む自己完結バンドル（約1.6MB）
        └── client-entry-*.css
```

### 主要な実装ポイント

**`createPdfViewer()`**（`src/pdfViewer.ts`）が公開 API で `{ mount, unmount }` を返す。

- **`scanAndTransform(root = document)`**: `root.querySelectorAll('a[href^="/attachment/"]')`（`root` が対象
  リンク自身の場合はそれも含める）で走査し、`isEligibleLink(a)` を通過したものを `enhanceLink()` する。
  `isHiddenContext()` が true の場合は何もしない。`root` を渡すことで MutationObserver 起点の再スキャンを
  スコープできる。
- **`isEligibleLink(link)`**: 以下を全て満たすもののみ対象
  - `data-gpv-enhanced` 属性を持たない（二重変換防止）
  - `href` が `/attachment/` で始まる
  - リンクテキスト（`link.textContent.trim()`）が `.pdf`（大小文字無視）で終わる
  - `isInEditorDOM(link)` が false（`.CodeMirror` / `.cm-editor` / `[contenteditable="true"]` 配下でない）
- **`enhanceLink(link)`**: リンクに `gpv-pdf-link` クラスと SVG アイコン（`createElementNS` で生成、`innerHTML`
  不使用）を追加し、直後に「PDFを表示」トグルボタンを挿入する。リンク自体のクリックは `preventDefault` して
  トグルボタンのクリックに委譲する（ダウンロード/別タブ遷移をさせないため）。
- **`toggleViewer(state)`**: 初回クリックで `createInlineViewer()` を呼び `viewer.expand()`、再クリックで
  `viewer.collapse()` して `state.viewer` を null に戻す。ボタンのラベルと `aria-expanded` を同期させる。
- **`restoreLink(state)`**: 開いていればまず `viewer.collapse()`、次に click リスナ解除・アイコン/トグルボタン
  削除・`gpv-pdf-link` クラス除去（除去後にクラスが空なら `class` 属性ごと削除）・`data-gpv-enhanced` 除去を行う。
- **`enhancedLinks`**: `Map<HTMLAnchorElement, EnhancedLink>` でリンク要素 → 付与状態を管理。`cleanupAll()` で
  全件反復して `restoreLink()` する。

### `createInlineViewer({ url, title, anchorEl })`（`src/inlineViewer.ts`）

- **ツールバー**: タイトル表示、ページインジケータ、ページ番号入力＋「移動」ボタン、ズーム(−/%/+)、
  ダウンロードリンク（`<a download>`、`href` は元の添付 URL）。すべて `createElement`/`createElementNS` で
  生成し `innerHTML` は使わない。
- **`expand()`**:
  1. `getDocument({ url })` で `PDFDocumentLoadingTask` を取得し `.promise` を待つ（後述: `getDocument(url)` の
     ように文字列を直接渡す呼び方は v6 の型では通らない）
  2. 1 ページ目を取得して `scale: 1` の `viewport` からページの基準サイズ（`baseUnscaledWidth/Height`）を求める
     （全ページ同一サイズという前提。異なる場合はページごとにサイズが揃わない可能性があるが未対応）
  3. 全ページ分の空プレースホルダー `div.gpv-page-placeholder` を並べ、高さだけ先に確保する
  4. `IntersectionObserver`（`rootMargin: '400px 0px'`, `threshold: [0, 0.5]`）で各プレースホルダーを監視
  5. `resize` はデバウンスして再レイアウト＋描画済みページの再描画を行う
- **`handleIntersect(entries)`**: `isIntersecting` なプレースホルダーのうち未描画のものを `renderPage()` する。
  `intersectionRatio >= 0.5` のページ番号でページインジケータを更新する（＝画面中央付近に来たページを
  「現在のページ」とみなす）。
- **`renderPage(pageNum)`**: `currentScale()` で現在のズーム・コンテナ幅から `scale` を算出し、`page.render({
  canvas, viewport })` で描画する。**`canvas` プロパティが必須**（`canvasContext` だけでは v6 の型が通らない、
  後述）。描画後に `TextLayer` でテキスト層を重ねる。
- **`changeZoom(delta)`**: `ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0]` のインデックスを増減し、プレースホル
  ダー高さを再計算した上で、**既に描画済みのページのみ**再描画する（未描画ページは次に可視化されたときに
  新しい scale で描画されるので不要）。
- **`collapse()`**: `IntersectionObserver.disconnect()`、進行中の `RenderTask.cancel()`、`resize` リスナ解除、
  `loadingTask.destroy()`（`pdfDoc.destroy()` ではない、後述）、コンテナ DOM 除去を行う。

### pdf.js のバンドル方針（自己完結・CDN 不使用）

GROWI はプラグインインストール時に `pnpm install`/`pnpm build` を実行せず `dist/` を静的配信するだけなので、
pdf.js の worker もビルド成果物に含めて自己完結させる必要がある。

```ts
import { GlobalWorkerOptions } from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
GlobalWorkerOptions.workerPort = new PdfjsWorker();
```

`?worker&inline` という Vite の特殊クエリ import により、worker が base64 化されて本体 JS バンドルに
インライン埋め込みされる。`workerSrc`（ファイルパス文字列）方式にしなかった理由は、GROWI がプラグインを
任意の静的パスから配信するため相対パス解決が壊れやすいため。トレードオフとしてバンドルサイズが増える
（`client-entry-*.js` が約 1.6MB、gzip 後約 500KB）が、配信パスに依存しない自己完結を優先した。

## pdf.js v6 (`pdfjs-dist`) API のハマりどころ（必読）

TypeScript の型チェックで判明した、よくある古いサンプルコードとの API 差分。

### 1. `getDocument()` は文字列ではなくオブジェクトを渡す

```ts
// NG（v6 の型では通らない）
const pdfDoc = await getDocument(url).promise;

// OK
const loadingTask = getDocument({ url });
const pdfDoc = await loadingTask.promise;
```

### 2. `page.render()` は `canvas` プロパティが必須

`canvasContext` 単体は「後方互換のため残っているが非推奨」という位置付けになっており、型上は `canvas:
HTMLCanvasElement | null` が必須プロパティになっている。

```ts
// NG
page.render({ canvasContext: ctx, viewport });

// OK
page.render({ canvas: canvasEl, viewport });
```

### 3. `destroy()` は `PDFDocumentProxy` ではなく `PDFDocumentLoadingTask` にある

`getDocument()` が返す `PDFDocumentLoadingTask` を保持しておき、そちらの `.destroy()` を呼ぶ。
`PDFDocumentProxy`（`loadingTask.promise` の解決値）には `destroy()` は無く、代わりに `cleanup()`
（ワーカー上のリソース解放。破棄ではなくクリーンアップ）がある。本プラグインでは `collapse()` 時に
`loadingTask.destroy()` を呼んでいる。

### 4. `TextLayer` はトップレベルから直接 export されている

v6 では別途 `pdfjs-dist/web/pdf_viewer` を読み込む必要はなく、`import { TextLayer } from 'pdfjs-dist'` で
使える。コンストラクタ引数は `{ textContentSource: page.streamTextContent(), container, viewport }`。
`render()` が Promise を返す。テキストレイヤー用の CSS（`.gpv-text-layer` 配下の `span`/`br` の位置・
`::selection` 等）は npm パッケージに同梱されていないため `pdfViewer.css` に手動で定義している
（pdf.js 公式の `text_layer_builder.css` 相当を再現）。

### 5. Vite の `?worker&inline` import には `vite/client` の型定義が必要

`tsconfig.json` の `compilerOptions.types` に `"vite/client"` を追加しないと、
`Cannot find module '...?worker&inline' or its corresponding type declarations.` で `tsc` がエラーになる
（`vite/client.d.ts` が `declare module '*?worker&inline' { ... }` を提供している）。

## その他のハマりどころ

### 6. `window.pluginActivators` のグローバル型拡張が必要

`client-entry.tsx` で `window.pluginActivators = ...` と代入するには、`strict: true` 環境では
`declare global { interface Window { pluginActivators?: ... } }` の型拡張が必須（`src/types.ts` に定義）。
無いと `tsc` がプロパティ不存在エラーを出す。

### 7. GROWI 添付リンクの `href` には拡張子が含まれない

GROWI の添付ファイルリンクは `[report.pdf](/attachment/<24桁のID>)` の形式で、`href` は不透明な ID のみ。
`.pdf` かどうかは **リンクテキスト（デフォルトは元のファイル名）側でしか判定できない**。そのため
`isEligibleLink()` は `href` のプレフィックス（`/attachment/`）とリンクテキストの拡張子の 2 つを別々に
チェックしている。ユーザーがリンクテキストを手動で書き換えて `.pdf` を含まなくなった場合は検出されなくなる
仕様上の制約がある（`href` に対する HEAD リクエストでの Content-Type 判定は行っていない）。

### 8. S3 / GCS Redirect Mode での CORS 失敗 → iframe フォールバック

GROWI が S3 / GCS を Redirect Mode で利用している場合（**GROWI Cloud はデフォルトでこの構成**）、
`/attachment/:id` は署名付き URL（`storage.googleapis.com` 等）への 302 リダイレクトになる。pdf.js は
`fetch()` で PDF バイナリを取得するため、リダイレクト先のバケットに wiki のオリジンを許可する CORS 設定が
無いと読み込みに失敗する。GROWI Cloud はマネージド SaaS のためこのバケットの CORS 設定はユーザー側では
変更できず、「CORS 設定はユーザー運用課題」として片付けることができない。

そのため `expand()` の `try/catch` で失敗を検知した場合、`showFallback()`（`src/inlineViewer.ts`）が
**`<iframe src="元のURL">`** によるブラウザ標準 PDF 表示にフォールバックする。`<iframe>` はブラウザが
表示を担当するだけで JS 側でレスポンスボディを読み取らないため、`fetch`/`XHR` と異なり **CORS の制約を
受けない**。フォールバック時は `gpv-pdfjs-only` クラスを持つツールバー要素（ページジャンプ・ズーム）を
`display: none` で隠し、タイトルとダウンロードボタンだけを残す（テキスト選択も pdf.js の text layer 由来
なので使えなくなる）。

これはセキュリティ上の外部通信ではなく、**本文中に既に存在するリンクの `href` へブラウザがナビゲーション
するのと同じ**（`<a>` を直接クリックした場合と同一オリジン・同一 URL への遷移）なので、CLAUDE.md の
「外部通信禁止」ルールには抵触しない。`sandbox` 属性は意図的に付与していない — Chrome 等のネイティブ PDF
プラグインが `sandbox="allow-scripts"` 無しでは動作しない場合があり、かつ表示対象は常に本文中の既存リンク
先（攻撃者が任意に注入できるものではない）であるため、サンドボックスによる追加の制限よりも表示の互換性を
優先した。

### 9. `dist/` を git にコミットすること

GROWI はプラグインインストール時に **`pnpm install` も `pnpm build` も実行しない**。GitHub の archive zip を
展開し、`dist/` 配下を Express で静的配信するだけ。

→ `.gitignore` に `dist/` を含めると GROWI 側で JS が読み込まれない。`dist/` は必ずコミットすること。

### 10. Vite のマニフェスト出力先

GROWI が読みに行く manifest のパスは以下の順で fallback:

1. `dist/.vite/manifest.json` (Vite 5 デフォルト)
2. `dist/manifest.json` (Vite 4 互換 / 明示設定時)

Vite 5+ では `vite.config.ts` で `build.manifest: 'manifest.json'` を明示してプロジェクト直下風のパスに
出力するのが無難。

### 11. 再インストールが必要

コード更新を push しても、GROWI 管理画面で「有効/無効トグル」だけでは zip が取り直されない。確実に反映
させるには `/admin/plugins` で **削除 → 再インストール**。

### 12. MutationObserver の自己ループ防止

トグルボタンのクリックでビューアの canvas/text layer を DOM に追加すると、その `childList` mutation が
`MutationObserver` に検知されてしまう。`isPluginNode(el)` で `.gpv-pdf-link` / `.gpv-toggle-btn` /
`.gpv-inline-viewer` を祖先に持つノードをスキップし、無限スキャンを防いでいる。

### 13. ダークモードの CSS 変数は2箇所を常に同期させること

`src/styles/pdfViewer.css` にはダークモード用の変数定義が **`@media (prefers-color-scheme: dark)`
（OS設定連動）と `html[data-bs-theme="dark"]`（GROWI UI トグル）の2箇所**に重複して存在する。片方だけ
値を変更すると、OS のダークモードと GROWI のダークモードトグルとで配色が食い違う不具合になる。配色を
変更する際は必ず両方のブロックを同時に更新すること。

### 14. 親要素の `overflow: hidden` が子要素の `position: sticky` を壊す

`.gpv-inline-viewer`（角丸の外枠をクリップする目的で `overflow: hidden` を付けていた）の直接の子である
`.gpv-toolbar` に `position: sticky; top: 0;` を指定しても、**ページをスクロールしてもツールバーが追従しない**
不具合が発生した。

原因: `overflow` が `visible` 以外の値（`hidden` / `scroll` / `auto` / `clip`）を持つ要素は、たとえ実際には
スクロールしない（コンテンツが自身の高さに収まっている）としても CSS 上は「スクロールコンテナ」として扱われ、
子孫の `position: sticky` はドキュメント全体のビューポートではなくその要素基準で計算されてしまう。
`.gpv-inline-viewer` は高さがコンテンツに自動フィットしており実際にはスクロールしないため、sticky 要素は
「stick すべき相対的なスクロール量」を得られず、常に静的な位置のまま親と一緒に流れてしまっていた。

対応: `.gpv-inline-viewer` から `overflow: hidden` を削除し、角丸のクリップは `.gpv-toolbar` に
`border-radius: var(--gpv-radius) var(--gpv-radius) 0 0`（上2隅）、`.gpv-fallback-iframe` に
`border-radius: 0 0 var(--gpv-radius) var(--gpv-radius)`（下2隅）を個別に指定する形に変更した。
今後 `.gpv-inline-viewer` 配下に `position: sticky` な要素を追加する場合、祖先に `overflow: hidden` 等を
安易に付けないこと。

### 命名規約

| 対象 | 値 |
|---|---|
| プレフィックス | `gpv-*` |
| enhanced マーカー属性 | `data-gpv-enhanced` |
| カスタムイベント名 | `gpv-navigate` |
| CSS 変数 | `--gpv-*` |
| リンククラス | `gpv-pdf-link` |
| トグルボタンクラス | `gpv-toggle-btn` |
| ビューアコンテナクラス | `gpv-inline-viewer` |
| pluginActivators キー | `growi-plugin-pdf-viewer` |

## 検証方法（実装時に実施したこと）

GUI 操作を目視確認できない実行環境では、`pnpm exec playwright install chromium` でヘッドレスブラウザを
用意し、ビルド後の `dist/assets/*` をローカル静的サーバー（`python3 -m http.server --bind 127.0.0.1`、
**必ずループバックにバインドする**こと。バインドアドレス省略は `0.0.0.0` で待受し LAN に公開されるため
許可されない）で配信して、Playwright スクリプトから `pluginActivators['growi-plugin-pdf-viewer'].activate()`
/ `.deactivate()` を直接呼び出し、リンク検出・展開・ズーム・ページジャンプ・折りたたみ・`unmount()` 後の
DOM 完全復元をコンソール評価とスクリーンショットで確認する、という手順で代替検証を行った。

## デプロイ手順

```bash
pnpm build              # dist/ を更新
git add src/ dist/ ...  # 変更ファイルを staging
git commit -m "..."
git push
```

GROWI 管理画面 `/admin/plugins` で **削除 → 再インストール**。

## 動作確認チェックリスト

1. `pnpm build` が成功し `dist/manifest.json` と `dist/assets/*` が出力される
2. GROWI で削除 → 再インストール後、DevTools Network で `client-entry-*.js` が 200 で取得される
3. `[report.pdf](/attachment/xxx)` 形式の添付リンクに「PDFを表示」ボタンが付く
4. 画像添付（`.png` 等）や `/attachment/` 配下でないリンクにはボタンが付かない
5. 「PDFを表示」でリンク直後にビューアが展開され、pdf.js が描画する
6. スクロールに応じて未描画ページが遅延描画される（一括描画されない）
7. ズーム（−/+）でページの拡大縮小と再描画が行われる
8. ページ番号を入力して「移動」すると該当ページへスクロールする
9. ダウンロードボタンで元の添付ファイルを取得できる
10. PDF 内のテキストを選択・コピーできる
11. 「PDFを閉じる」で描画済み内容が破棄されビューアが折りたたまれる
12. 同一ページ内の複数 PDF リンクを同時に展開できる
12a. 長い PDF を下までスクロールしてもツールバーが追従し、ツールバー右端の ✕ ボタンで閉じられる。押すと
    外側の「PDFを表示」トグルの表示も同期して戻る
12b. 未描画のページにスピナーが表示され、`IntersectionObserver` で描画され次第消える
13. 編集モードへ遷移するとトグル UI が消え元の `<a>` に戻る。編集モードから戻ると再度ボタンが付く
14. SPA 遷移後の新ページの PDF リンクも自動検出される
15. `/admin` 配下では変換が行われない
16. `.CodeMirror` / `.cm-editor` 配下の PDF リンクには変換が行われない
17. `unmount()` 後、`data-gpv-enhanced` / `gpv-pdf-link` クラス / アイコン / トグルボタンが一切残らず元の
    `<a>` に戻る
18. ダークモード切替（OS / GROWI UI トグルの両方）でツールバー等の配色が同じように適切に変わる
19. 印刷プレビューでツールバーが非表示になる
20. （S3/GCS Redirect Mode 環境、または Playwright の `page.route().abort()` 等で fetch を失敗させた場合）
    CORS 失敗時に iframe フォールバックへ切り替わり、タイトル・ダウンロードボタン以外のツールバー操作が
    非表示になる

## 会話ガイドライン

- 常に日本語で会話する

## 作業ルール

- **git 操作は行わない**。`git add` / `git commit` / `git push` / `git restore` / `git checkout` などの git コマンドは一切実行しないこと。コミットやプッシュが必要な場面ではユーザーに依頼し、こちらでは行わない。
  - 変更内容のサマリだけ提示し、コミットメッセージ案を出す程度に留める。
  - 例外として `git status` / `git log` / `git diff` などの**読み取り専用**コマンドは状況把握のために実行してよい。
- **pnpm 操作は Claude が行う**。`pnpm install` / `pnpm approve-builds` / `pnpm build` / `pnpm audit` はこちらで実行する。

- **セキュリティチェックを必ず行う**。コード変更を完了したら、コミット候補としてユーザーに提示する前に以下を確認すること。問題が見つかった場合はその場で修正するか、ユーザーに明示的に報告する。
  - **機密情報の混入**: API キー / トークン / パスワード / 秘密鍵 / `.env` 系ファイルの値が、ソースコード・コメント・`dist/` 配下のビルド成果物に含まれていないか。
  - **XSS / 危険な HTML 挿入**: ユーザー入力を `dangerouslySetInnerHTML`・`innerHTML` で未エスケープで埋め込んでいないか。DOM 操作は `createElement`/`createElementNS` + `setAttribute` のみを使うこと。
  - **外部通信**: 外部 URL に対する `fetch` / `XMLHttpRequest` を新規追加していないか（pdf.js が fetch するのは本文中のリンクが指す添付ファイル URL のみ。CDN 依存は禁止）。CORS フォールバックの `<iframe src>` はリンク先への表示専用ナビゲーションであり `fetch`/`XHR` ではないため、この意味での「外部通信の新規追加」には該当しない（[ハマりどころ #8](#8-s3--gcs-redirect-mode-での-cors-失敗--iframe-フォールバック) 参照）。
  - **依存パッケージの脆弱性**: 新規追加した npm パッケージは `pnpm audit` を実行して確認する。
  - **CSP / 外部リソース**: `<script>` / `<link>` を動的挿入して外部ドメインから読み込む実装になっていないか。自己完結なバンドルにすること（pdf.js worker もインライン化済み）。

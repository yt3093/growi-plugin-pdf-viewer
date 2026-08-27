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
| トグル UI | 対象リンクにアイコン＋「View PDF」ボタンを付与。押すとリンク直後にビューアを展開、再度押すと閉じる |
| インライン展開 | モーダルではなく本文の流れの中にビューアを挿入する方式 |
| 遅延描画 | 全ページ分のプレースホルダーを先に並べ、`IntersectionObserver` で可視ページに近づいたものだけ canvas 描画する |
| 遠くにスクロールしたページの解放 | 描画済みページも、画面から大きく離れる（`IntersectionObserver` の別インスタンス、マージン3000px）と canvas/text layer を破棄してメモリを解放する。プレースホルダーの高さは維持するのでスクロール位置は動かない。再度近づけば自動で再描画される（後述ハマりどころ #22） |
| ズーム | ツールバーのボタンで拡大/縮小。プレースホルダー高さと描画済みページを再計算・再描画する |
| ページジャンプ | ページ番号を入力してそのページへ `scrollIntoView` |
| ダウンロード | ツールバーに元の添付 URL への `download` リンクを設置 |
| テキスト選択・コピー | pdf.js の `TextLayer` を canvas に重ねて配置し、文字選択・コピーを可能にする |
| 複数同時展開 | 同一ページ内の複数 PDF リンクは、それぞれ独立してビューアを持ち同時展開できる |
| ツールバー内クローズボタン | `.gpv-toolbar` は `position: sticky` で追従するため、外側の「View PDF / Close PDF」トグルがスクロールで画面外に出た後でも、ツールバー右端の ✕ ボタンから閉じられる。押すと `onRequestClose` 経由で外側トグルの表示（テキスト/`aria-expanded`）も同期する |
| ページ読み込みスピナー | 未描画のページプレースホルダーに回転スピナーを表示し、`renderPage()` が最初に呼ばれた時点（canvas 挿入時）で消える。`prefers-reduced-motion: reduce` では回転を止める |
| CORS フォールバック | pdf.js の `fetch` が失敗（CORS 等）した場合、`fetch(url, {mode:'no-cors'})` で到達可能性を確認した上で `<iframe src="元のURL">` によるブラウザ標準 PDF 表示にフォールバックする。ズーム/ページジャンプ/テキスト選択は使えないが「見られない」状態は回避する。到達不能（ネットワーク層で完全に失敗）の場合はダウンロード導線のみのエラー表示にする（後述ハマりどころ #21） |
| タッチ操作対応 | `.gpv-btn`（ページ移動/ズーム/ダウンロード/閉じる）を28→34pxに拡大しタップしやすくした。モバイル実機エミュレーション（iPhone/Pixel/iPad）で横スクロール発生無し・全操作がタップで機能することを確認済み |
| DOM 復元 | `unmount()` 時にアイコン・トグルボタン・enhanced マーカー・付与クラスを全て除去し元の `<a>` に戻す |
| SPA 遷移 | `pushState` / `replaceState` モンキーパッチ + `popstate` + `hashchange` で再スキャン（フルスキャン） |
| 動的追加対応 | `MutationObserver` で `<a>` 追加を検知し、変更があった部分木だけを対象にスコープされた再スキャンを行う |
| エディタ DOM 除外 | `.CodeMirror` / `.cm-editor` / `[contenteditable="true"]` 配下の要素は対象外 |
| 非実行条件 | 編集モード（`/edit`, `#edit`, `body.editing`, `body.grw-editor-mode`, `body.modal-open`）・管理画面（`/admin`）では実行しない |
| ダークモード | `@media (prefers-color-scheme: dark)` と `html[data-bs-theme="dark"]`（Bootstrap 5.3 GROWI UI トグル）の双方で配色を切り替える（2 箇所は値を同期させること） |
| 印刷対応 | `@media print` でツールバー等の操作 UI を非表示にする。加えて `beforeprint` イベントで開いている全ビューアの未描画ページを強制描画し、遅延描画のせいで印刷結果が空白になるのを防ぐ（ベストエフォート、後述ハマりどころ #18） |
| アイコンツールバー | ページ移動/ズーム/ダウンロード/閉じるを全て `title`/`aria-label` 付きのアイコンボタンに統一し、日本語テキストと英語トグル文言の混在を解消 |
| 展開アニメーション | `.gpv-inline-viewer` の `opacity`/`transform` トランジションで滑らかに展開・折りたたみ。`prefers-reduced-motion: reduce` では無効化 |
| 特定ページへの直接リンク | `/attachment/xxx#page=5` のようにリンクの `href` に `#page=N` を付けると、展開時にそのページへ自動ジャンプする（`scrollIntoView({behavior:'auto'})`）。Adobe の PDF Open Parameters 由来の慣習的な記法で、Chrome 等のブラウザ標準 PDF ビューアも同じ記法を認識するため CORS フォールバックの `<iframe>` でも副次的に機能する |
| 読み込み進捗表示 | `loadingTask.onProgress` で「読み込み中… N%」を表示。`total` が不明な場合（サーバーが `Content-Length` を返さない等）は `読み込み中…` のみ表示しパーセンテージを出さない |
| 読み込み失敗時の自動リトライ | `fetch` はブロック理由（CORS か一時的な失敗か）を JS 側から区別できないため、1 回目の失敗ではエラー表示をせずバックグラウンドで自動的に1回だけ再読み込みする。2 回目も失敗して初めて CORS フォールバック（iframe）に切り替える。GROWI Cloud のように毎回必ず CORS で失敗する環境で「失敗表示→手動で再試行ボタンを押す」という手間を毎回発生させないための設計（後述ハマりどころ #19・#20） |

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
  不使用）を追加し、トグルボタンを挿入する。リンク自体のクリックは `preventDefault` して
  トグルボタンのクリックに委譲する（ダウンロード/別タブ遷移をさせないため）。
  `createPdfIcon()` は [Wikimedia Commons の「PDF icon.svg」]
  (https://upload.wikimedia.org/wikipedia/commons/6/6c/PDF_icon.svg) の座標をそのまま踏襲した再現。
  折れ角付きの白い書類＋両端がノッチ状に切り欠かれた赤いリボン帯（単純な矩形ではない）＋白抜き「PDF」文字。
  参照元は `viewBox="0 0 14 16"` の座標に `matrix(.04589 0 0 .04589 -.66877 -.73379)` という transform が
  掛かった生データ（Illustrator/Inkscape 由来と思われる、`fill` のみで縁取りを表現する二重パス等の複雑な
  構造）だったため、その transform を手計算で適用した座標値を使い、書類の輪郭（`M8.87 0H1.34v16h11.33V3.8z`）
  とリボン帯（`polygon points="13.6,12.3 0.4,12.3 0.4,7.0 1.0,6.3 1.0,7.1 13.0,7.1 13.0,6.3 13.6,7.0"`）を
  シンプルな `fill`+`stroke` で再構成している（見た目は同一、マークアップは大幅に単純）。唯一の意図的な
  差分は「PDF」の文字部分で、参照元は文字を輪郭パス化した図形だが、本実装では単純に `<text>` 要素で代用して
  いる（3 文字分のグリフパスを持つ必要はなく、この 16px 程度の使用サイズでは見た目上の違いも出ない）。
  書類部分の塗り/線は `var(--gpv-bg)`/`var(--gpv-border)` を使い、ダークモードで白い正方形が浮かないように
  テーマに追従させている。赤帯（`var(--gpv-pdf-badge)`）は固定色。`viewBox` は元データに合わせて
  `0 0 14 16`（正方形ではない）にしており、`width`/`height` もそれぞれ `14`/`16` を指定している。
  トグルボタン自体も `createPdfIcon()`（`.gpv-toggle-icon`）＋ `span.gpv-toggle-label`（初期値 `View PDF`）の
  子要素構成にしている。ラベルは開閉のたびに丸ごと差し替えるのではなく `setToggleLabel()` が
  `.gpv-toggle-label` の `textContent` だけを更新するので、アイコンを毎回作り直さずに済む。ボタン文言は
  英語（`View PDF` / `Close PDF`）に統一している一方、ツールバー内の他の文言（ページ移動・ダウンロード等）は
  日本語のまま残っており、UI 文言の言語は現時点で統一されていない。
  **`title` は `link.textContent` を `enhanceLink()` の冒頭（アイコン挿入より前）で一度だけ読んでキャッシュ
  し、`EnhancedLink.title` として保持している**（後述ハマりどころ #16 参照）。
- **`findBlockContainer(link)`**: トグルボタンの挿入位置を決める。`link.closest('p, li, td, th, dd, dt,
  blockquote')`（無ければ `link.parentElement`）でリンクの文章が属するブロック要素を求め、そのブロックの
  直後（`insertAdjacentElement('afterend', ...)`）にボタンを置く。これにより、ボタンは文中のリンクのすぐ
  右ではなく、**段落など「枠」全体の下に新しい行として**現れる。
- **`toggleViewer(state)`**: 初回クリックで `createInlineViewer()` を呼び `viewer.expand()`、再クリックで
  `viewer.collapse()` して `state.viewer` を null に戻す。ボタンのラベルと `aria-expanded` を同期させる。
- **`restoreLink(state)`**: 開いていればまず `viewer.collapse()`、次に click リスナ解除・アイコン/トグルボタン
  削除・`gpv-pdf-link` クラス除去（除去後にクラスが空なら `class` 属性ごと削除）・`data-gpv-enhanced` 除去を行う。
- **`enhancedLinks`**: `Map<HTMLAnchorElement, EnhancedLink>` でリンク要素 → 付与状態を管理。`cleanupAll()` で
  全件反復して `restoreLink()` する。

### `createInlineViewer({ url, title, anchorEl })`（`src/inlineViewer.ts`）

- **ツールバー**: タイトル表示、ページインジケータ、ページ番号入力＋移動アイコン、ズーム（縮小/％/拡大）、
  ダウンロード、閉じる、を全て**アイコンボタン**（`.gpv-btn` = 34×34px、`title`/`aria-label` でツールチップ兼
  アクセシブルネームを付与）で統一している。可視テキストが「移動」「ダウンロード」等の日本語と
  トグルボタンの英語（`View PDF`）で混在するのを避けるため、テキストラベル自体を無くしアイコンのみにした。
  アイコンは `createStrokeIcon()`（16×16, `stroke="currentColor"`）ベースの小さなヘルパー群
  （`createJumpIcon` / `createZoomOutIcon` / `createZoomInIcon` / `createDownloadIcon` / `createCloseIcon`）
  で生成し、`createToolbarSeparator()` でグループ間に区切り線を挟む。すべて `createElement`/`createElementNS`
  で生成し `innerHTML` は使わない。
- **展開/折りたたみのフェードイン**: `.gpv-inline-viewer` は `opacity: 0; transform: translateY(-6px);` を基準
  状態とし、`.gpv-open` クラスで `opacity: 1; transform: translateY(0);` に遷移する（`transition:
  opacity/transform`）。`expand()` は要素を DOM に追加した**直後は `.gpv-open` を付けず**、2 段の
  `requestAnimationFrame` を挟んでから追加する（同一 tick で追加すると初期状態の描画がスキップされ
  トランジションが発火しないことがあるため。message-notation の SPA 再スキャンで使っている 2 段 rAF と
  同じ考え方）。`collapse()` は `.gpv-open` を外してから `transitionend`（または `CLOSE_TRANSITION_MS`
  経過後のフォールバック `setTimeout`）で実際に DOM を除去する。**あえて `max-height` によるアコーディオン風
  の高さアニメーションは採用していない**: 中身の高さは遅延描画・ズームで継続的に変わるため、`max-height` を
  都度再計測し続ける実装は複雑さ・不具合リスクの割に効果が薄いと判断し、`opacity`/`transform` のみに絞った
  （詳細はハマりどころ #15 参照）。
- **`expand()`** / **`attemptLoad(status)`**: `expand()` はコンテナ DOM を組み立てて開閉アニメーションの
  トリガーだけ行い、実際の読み込みは `attemptLoad()` に委譲している。失敗時に同じ関数を（ユーザー操作を
  介さず）自分自身から再度呼び直せるようにするための分離。`attemptLoad()`:
  1. 前回（リトライ時）の `loadingTask` があれば破棄をキューに積み、`waitForPendingWorkerTeardown()` で
     破棄完了を待ってから次に進む（後述ハマりどころ #19）
  2. `getDocument({ url })` で `PDFDocumentLoadingTask` を取得し、`loadingTask.onProgress` で `.gpv-status` に
     `読み込み中… N%` を反映しながら `.promise` を待つ（後述: `getDocument(url)` のように文字列を直接渡す
     呼び方は v6 の型では通らない）
  3. 1 ページ目を取得して `scale: 1` の `viewport` からページの基準サイズ（`baseUnscaledWidth/Height`）を求める
     （全ページ同一サイズという前提でレイアウトする）
  4. 全ページ分の空プレースホルダー `div.gpv-page-placeholder` を並べ、高さだけ先に確保する
  5. `IntersectionObserver`（`rootMargin: '400px 0px'`, `threshold: [0, 0.5]`）で各プレースホルダーを監視
  6. `resize` はデバウンスして再レイアウト＋描画済みページの再描画を行う
  7. `initialPage`（`#page=N` から解析済み）があれば `jumpToPage(startPage, 'auto')` でそのページへ即座に
     ジャンプする（`'auto'` を使うのは、開いた直後にスムーズスクロールさせるとフェード/スライド展開の
     アニメーションと衝突して見た目がちぐはぐになるため）
  失敗時（`catch`）: `loadAttempts` をインクリメントし、1 回目は**ユーザーに何も見せず** `attemptLoad(status)`
  を自分自身から呼び直す（サイレントリトライ）。2 回目以降は `showFallback()`（iframe フォールバック）を
  表示する。ボタン等の UI を挟まない理由はハマりどころ #20 を参照。
- **`handleIntersect(entries)`**: `isIntersecting` なプレースホルダーのうち未描画のものを `renderPage()` する。
  `intersectionRatio >= 0.5` のページ番号でページインジケータを更新する（＝画面中央付近に来たページを
  「現在のページ」とみなす）。
- **`renderPage(pageNum)`**: `currentScale()` で現在のズーム・コンテナ幅から `scale` を算出し、`page.render({
  canvas, viewport })` で描画する。**`canvas` プロパティが必須**（`canvasContext` だけでは v6 の型が通らない、
  後述）。描画後に `TextLayer` でテキスト層を重ねる。
- **`changeZoom(delta)`**: `ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0]` のインデックスを増減し、プレースホル
  ダー高さを再計算した上で、**既に描画済みのページのみ**再描画する（未描画ページは次に可視化されたときに
  新しい scale で描画されるので不要）。
- **`unloadPage(pageNum)` / `handleUnloadIntersect(entries)`**: 描画済みページのメモリを解放する仕組み。
  `renderPage()` 用の `observer`（`rootMargin: 400px`）とは**別の** `IntersectionObserver` インスタンス
  （`unloadObserver`、`rootMargin: 3000px`）を用意し、その大きなマージンの外に出た（＝`isIntersecting: false`
  になった）ページの canvas/text layer を破棄して `entry.rendered = false` に戻す。プレースホルダーの
  `style.height` はそのまま維持するのでスクロール位置は動かない。`rendered` フラグを false に戻すだけなので、
  再びページが近づけば `observer`（render 側）が今まで通り自動で再描画する——「まだ一度も描画していない
  ページ」と全く同じ経路で復帰する。なぜ2つの `IntersectionObserver` を使うのか、1つのマージンを共有しない
  理由はハマりどころ #22 を参照。
- **`collapse()`**: `IntersectionObserver.disconnect()`、進行中の `RenderTask.cancel()`、`resize` リスナ解除、
  `loadingTask` があれば `destroyLoadingTaskAsync()`（`pdfDoc.destroy()` ではない、後述）でモジュール共有の
  破棄キューに積む、コンテナ DOM 除去を行う。
- **`jumpToPage(target, behavior = 'smooth')`**: 通常のページジャンプ入力は `'smooth'`、`attemptLoad()` からの
  初期表示ジャンプ（`initialPage`）は `'auto'`（即座）を渡す。
- **`prepareForPrint()`**: `pages` の中で `rendered` が false のものだけ `renderPage()` を呼ぶ（既に描画済みの
  ページは触らない）。`pdfViewer.ts` 側の `beforeprint` リスナから、開いている全ビューアに対して呼ばれる。

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

### 15. 展開アニメーションを `opacity`/`transform` に留め、`max-height` アコーディオンにしなかった理由

見た目改善の一環で「展開/折りたたみをふわっとしたアニメーションにしたい」という要望があった際、素朴な実装
（デモの HTML モックアップで最初に作った案）は `max-height: 0 → 十分大きな固定値` を `transition` させる
アコーディオン風のものだった。しかし実装を進めると、本プラグインのビューアには次の性質があり、固定
`max-height` や単純な `scrollHeight` 計測では長期的に破綻することが分かった。

- 中身の高さは `expand()` 直後（「読み込み中…」の短い文言のみ）→ 全ページ分のプレースホルダーが並んだ直後
  （ページ数 × プレースホルダー高さ、数千px になり得る）→ 各ページが遅延描画されるたびに実寸へ更新、という
  具合に**開いた後も継続的に変化し続ける**
- ズーム変更（`changeZoom`）でも既存ページの高さが再計算される
- 上記のたびに `max-height` を再計測・再設定しないと、後から中身が伸びたときに古い `max-height` でクリップ
  されてしまう。かといって都度計測すると、遅延描画のたびに `max-height` が動いてガタつく見た目になりかねない

そのため、`max-height` によるクリップ/展開は行わず、**`opacity` + `transform: translateY()` のみ**を
トランジションさせる方式にした。中身の高さがどう変化しても不整合が起きず、`.gpv-toolbar` の
`position: sticky`（ハマりどころ #14）とも競合しない（`overflow: hidden` を必要としないため）。

`collapse()` 側は `.gpv-open` を外した直後に `container` 変数を `null` にしてしまうため、実際の DOM 除去は
`transitionend` イベント（複数プロパティが同時に transition している場合 `{ once: true }` で最初の1回だけ
処理すれば十分）と、念のためのフォールバック `setTimeout(..., CLOSE_TRANSITION_MS)` の**どちらか早い方**で
行っている。`remove()` は既に親を持たない要素に対して呼んでも何も起きない（例外にならない）ため、両方が
発火しても問題ない。

`prefers-reduced-motion: reduce` では `.gpv-inline-viewer` の `transition` を丸ごと無効化し、クラス切り替え
自体は即座に反映されるようにしている（アニメーション抑制の設定を尊重しつつ機能は変わらない）。

### 16. アイコンに文字を入れたことで `link.textContent` の読み取りが壊れた実例

`createPdfIcon()`（`pdfViewer.ts`）は当初、折れ角付きのページ形状だけの純粋な線画だった。視認性改善のため
「角丸の赤バッジ＋白抜き文字『PDF』」のロゴ風デザインに変更した際、SVG の `<text>` 要素で `PDF` という
文字を直接描画するようにした（`label.textContent = 'PDF'`）。

このアイコンは `enhanceLink()` で対象の `<a>` 要素の**内部**（`link.insertBefore(icon, link.firstChild)`）に
挿入される。ここで、アイコン挿入後に `link.textContent` を読むと、SVG の `<text>` ノードの中身（`"PDF"`）が
本来のリンクテキスト（例: `"tracemonkey-report.pdf"`）の前に連結され、`"PDFtracemonkey-report.pdf"` に
なってしまう。`aria-hidden="true"` は支援技術のアクセシビリティツリーからは隠すが、**DOM の `textContent`
プロパティには一切影響しない**ため、これは静かに発生する。

実際に `toggleViewer()` が `state.link.textContent?.trim()` を`インライン展開直後`（＝アイコン挿入後）に
読んでビューアのタイトル・ダウンロードファイル名として使っていたため、実際に「PDFtracemonkey-report.pdf」
という壊れたファイル名が表示される不具合になっていた。

対応: `enhanceLink()` の**冒頭・アイコン挿入より前**に `const title = link.textContent?.trim() ?? '';` で
一度だけ確定させ、`EnhancedLink.title` としてキャッシュする形に変更した。以後は `state.link.textContent`
を再度読まず、常に `state.title` を使う。**アイコン（またはトグルボタン等、リンク内に追加する任意の装飾要素）
に文字ノードを含めた場合、その要素より後に挿入される装飾は必ず「リンク本来のテキストを先に確定させてから
DOM を書き換える」順序を守ること。**

### 17. GROWI 実機で `.gpv-pdf-link` にホバーしてもポインターカーソルにならない

GROWI Cloud に実際にインストールして確認したところ、`a.gpv-pdf-link`（本文中の添付リンク）にマウスホバー
しても指カーソル（`cursor: pointer`）にならない不具合が報告された。ローカルの素の HTML（GROWI 側の CSS
無し）で確認すると `getComputedStyle(link).cursor` は `"pointer"` を返す（`<a href>` に対するブラウザの
UA デフォルト）ため、プラグイン単体の CSS 自体には問題が無い。原因は、GROWI 側のテーマ CSS（Bootstrap
ベース）が本プラグインの CSS より後に評価される、または同等以上の詳細度のセレクタで `a` / `svg` の
`cursor` をリセットしていると推測される。

**同じ理由で `.gpv-toggle-btn` / `.gpv-btn` には元々 `cursor: pointer` を明示している**（`<button>` 要素は
ブラウザによって既定で `cursor: pointer` にならないため）。`a.gpv-pdf-link` にはこの明示指定が抜けていた。

対応: `a.gpv-pdf-link, a.gpv-pdf-link *` に `cursor: pointer !important;` を明示した。子要素（SVG アイコン）
まで含めているのは、GROWI 側が `svg { cursor: ... }` のように子要素だけを狙って上書きしてくるケースにも
耐えるため。`!important` を使っているのは数少ない正当なケース（自分たちの管理外のホストページ CSS と
衝突しており、かつこのプロパティについてホスト側が優先されるべき理由が無いため）。Playwright で
「プラグイン CSS 読み込み後に `.wiki a { cursor: default }` 等を追加注入」というシナリオを模擬し、
`!important` 無しでは有効にならないケース（ホスト側セレクタが同等以上の詳細度の場合）でも
`cursor: pointer` が維持されることを確認済み。

### 18. `beforeprint` での強制描画はベストエフォート止まり（原理的な限界）

遅延描画（`IntersectionObserver`）により、スクロールしてまだ画面に近づいていないページは印刷時にも
未描画（空白）のまま出力されてしまう問題があった。対応として `window.addEventListener('beforeprint', ...)`
で開いている全ビューアの未描画ページに対して `renderPage()` を呼び出す（`InlineViewerHandle.prepareForPrint()`）
実装を追加した。

ただし、これは**確実な解決策ではなくベストエフォート**であることを明記しておく。`beforeprint` イベントは
印刷実行前に発火するが、ブラウザは**非同期処理の完了を待ってから印刷を開始するわけではない**
（スクリプト側に印刷を遅延させる標準的な手段が無い）。`page.render()` は Promise を返す非同期処理のため、
理論上は「ビューアを開いた直後に即座に印刷した」場合、`beforeprint` ハンドラが `renderPage()` を呼び出して
いる最中に印刷が実行され、一部のページが描画途中のまま出力される可能性が残る。

Playwright での検証では `window.dispatchEvent(new Event('beforeprint'))` を発火させてから
`renderTask.promise` の完了を待つ時間（実測: 14 ページで 1.5 秒程度）を確保すれば全ページ描画されることを
確認しているが、これは「スクリプトからイベントを発火してから十分待った場合」の確認であり、**実際のブラウザ
の印刷ダイアログがどれだけ待ってくれるかは保証されていない**。この制約はブラウザの仕様上の限界であり、
本プラグイン側だけでは解決できない（対応するとすれば `max-height`/`IntersectionObserver` を使わず
全ページを常時レンダリングする設計に変える必要があるが、それは遅延描画によるパフォーマンス上の利点を
失うトレードオフになるため採用していない）。

### 19. `loadingTask.destroy()` を `await` せず次の `getDocument()` を呼ぶと Worker が壊れる

読み込み失敗時に同じ URL で `getDocument()` をもう一度呼ぶリトライ機能を実装した際、実機で以下の
エラーが再現した。

```
PDFWorker.create - the worker is being destroyed.
Please remember to await `PDFDocumentLoadingTask.destroy()`-calls.
```

原因: 本プラグインは `GlobalWorkerOptions.workerPort` を `pdfViewer.ts` の**モジュール読み込み時に一度だけ**
生成し、**全ての `createInlineViewer()` インスタンスで共有**している（バンドルサイズの都合上、PDF ごとに
別々の worker を作る設計にしていない）。`loadingTask.destroy()` は非同期に worker 側のリソース解放を行うが、
`void loadingTask.destroy();`（await しない fire-and-forget）で呼んだ直後に同じ（または別の）インスタンスが
`getDocument()` を呼ぶと、共有 worker の破棄処理がまだ終わっていない状態で新しいドキュメントの読み込みが
始まってしまい、上記のエラーで失敗する。

再現条件は「読み込み失敗 → 再試行」のような**同一インスタンス内での連続呼び出し**だけでなく、**あるビューア
を閉じた直後に別のビューア（または同じリンクを再度）を開く**という、一見無関係な操作の組み合わせでも
理論上発生しうる（共有 worker を介しているため、インスタンスをまたいで競合する）。

対応: モジュールスコープ（`createInlineViewer` の外、全インスタンスで共有）に `workerTeardownChain` という
Promise チェーンを持たせ、`destroyLoadingTaskAsync(task)` で破棄を `.then()` チェーンに積み、
`waitForPendingWorkerTeardown()` で「現在キューに積まれている破棄が全て完了するまで待つ」ようにした。
`collapse()` は `destroyLoadingTaskAsync()` を呼ぶだけで同期的なまま（キューに積むだけなので待たない）、
`attemptLoad()` は `getDocument()` を呼ぶ**前**に必ず `await waitForPendingWorkerTeardown()` する。
これにより「自分自身の直前の破棄」だけでなく「別インスタンスが直前に積んだ破棄」も含めて正しく順序付けられる。

検証: Playwright で「読み込み失敗→再試行→（別の一時的失敗ではなく）成功」のシナリオと、「同じビューアを
待ち時間なしで開く→閉じる、を3回連続で繰り返してから最後に開く」という worst-case を再現し、いずれも
コンソールエラー無く正常に描画されることを確認した。

### 20. 読み込み失敗時のリトライは「手動ボタン」ではなく「自動サイレント」にすること

読み込み失敗時のリトライ機能を最初に実装したとき、1 回目の失敗で「PDFを読み込めませんでした。[再試行]」と
いうメッセージ＋ボタンを表示し、ユーザーがクリックして初めて 2 回目の試行（失敗すればフォールバック）に
進む UI にしていた。これは実機（GROWI Cloud）で「PDF を表示するたびに毎回失敗メッセージが一瞬見えて、
手動でボタンを押さないとフォールバックにも到達しない」という体験になり、ユーザーから「初期状態が
『読み込めない』になる」と指摘された。

原因: GROWI Cloud の CORS 問題（ハマりどころ #8）は**毎回必ず**発生する持続的な失敗であり、一時的な
ネットワーク瞬断のような「たまに起きる失敗」ではない。1 回目の失敗を人間に見せてボタンを押させる設計は、
「本当にたまにしか起きない失敗」を想定した UI であり、「ほぼ100%のユーザーが必ず踏む失敗」に対しては
単なる毎回の追加クリックでしかなく、むしろリトライ機能導入前（失敗即フォールバック）より手間が増える
退行になっていた。

対応: 1 回目の失敗はエラーメッセージを一切見せず、`attemptLoad()` が自分自身を再度呼び出す**サイレント
リトライ**に変更した。ユーザー操作を挟まないため、一時的な失敗はユーザーに気付かれずに直り、持続的な
失敗（CORS 等）でも「読み込み中…」がわずかに長く続くだけで、追加のクリックなしに自動でフォールバックへ
到達する。**教訓**: 「失敗した処理をリトライする」機能を作るとき、その失敗が「稀にしか起きない」のか
「特定の環境では常に起きる」のかによって適切な UI が真逆になる。後者が現実的にありうる場合、確認ダイアログ
的なボタンを挟むと、まさにその環境のユーザー全員に対して恒常的な UX 低下になる。

### 21. `<iframe>` の `load` イベントは「成功した」ことの証明にならない

CORS フォールバックの `<iframe>` について、「読み込みに失敗したまま永久に空白表示になる」ケース（サーバーに
全く到達できない等）を検知したいという要望があった。最初に実装したのは `iframe.addEventListener('load',
...)` ＋タイムアウトという素朴な方式（`load` が一定時間発火しなければ失敗とみなす）だったが、Playwright で
実際にネットワーク到達不能をシミュレートしたところ、**`load` イベントは正常に発火してしまい、タイムアウトが
一切発動しなかった**。

原因: ブラウザは `<iframe>` のナビゲーションが失敗した場合（DNS 解決失敗・接続拒否など）、**ブラウザ自身が
生成する「このサイトにアクセスできません」的なエラーページを iframe の中に表示し、そのエラーページの読み込み
完了をもって `load` イベントを発火させる**。`<img>`/`<script>` と違って `<iframe>` には信頼できる `error`
イベントが実質的に存在しない。つまり `load` は「何らかのドキュメント（それがエラーページであっても）の
描画が完了した」ことしか意味せず、「意図したコンテンツの表示に成功した」ことの証明には全くならない。

対応: `<iframe>` を作る**前**に `fetch(url, { mode: 'no-cors' })` で到達可能性を確認する方式に変更した。
`no-cors` モードのレスポンスは不透明（内容もステータスコードも読めない）だが、**何らかの HTTP レスポンスが
返ってきた時点で resolve し、DNS 解決失敗・接続拒否・オフライン等の真のネットワーク層の失敗でのみ reject
する**という性質があるため、「CORS で本文は読めないが到達はしている」（今回の GCS Redirect Mode のケース）
と「そもそも到達できない」を正しく区別できる。実際に、`route.fulfill()` で本物のクロスオリジン 302
リダイレクト（`Access-Control-Allow-Origin` の無い別オリジンの `127.0.0.1:8935` へ）を再現し、ユーザーの
実機で見えたのと同一の CORS エラーメッセージがコンソールに出る状況でも `no-cors` プローブは正しく
到達可能と判定し iframe を表示すること、および `route.abort('failed')` による完全な到達不能では
iframe を作らず即座にエラーメッセージを出すことを、両方 Playwright で確認済み。

**教訓**: `<iframe>` の読み込み成功可否を親ページの JS から知りたい場合、`load`/`error` イベントは
信頼できない（`load` は失敗時のエラーページ表示でも発火する）。到達可能性そのものを知りたいだけなら、
`fetch(url, { mode: 'no-cors' })` の resolve/reject の方が正確な信号になる。

### 22. ページ解放（unload）とページ描画（render）で `IntersectionObserver` のマージンを共有してはいけない

長い PDF を最後まで読み進めると、遅延描画で作られた canvas が画面外に出た後も一切解放されず、ページ数に
比例してメモリを使い続ける問題があった（1ページあたり概算 5〜20MB、数百ページの文書なら GB 単位になりうる。
特にモバイルブラウザはタブのメモリ使用量が一定を超えると通知なくタブを強制終了することがあるため、実害が
出やすい）。

対応として「画面から大きく離れたページの canvas を破棄する」`unloadPage()` を実装したが、**最初に検討した
「`renderPage()` 用の `observer` が `isIntersecting: false` を報告したら即座に unload する」という設計は
採用しなかった**。理由は、render 用の `observer` の `rootMargin` は 400px（先読みのための狭いマージン）
であり、これと同じ境界を unload の基準にすると、ユーザーがその 400px 境界の**すぐ内側と外側を行ったり
来たりするスクロール**をしただけで、render→unload→render→unload… を毎フレーム引き起こしかねない
（キャンバス再生成と pdf.js の再ラスタライズは軽くない処理のため、これが起きるとスクロールがガクつく）。

対応: render 用とは別に、**大幅に大きいマージン**（3000px）を持つ 2 個目の `IntersectionObserver`
（`unloadObserver`）を用意した。「400px 以内に近づいたら描画する」に対して「3000px より遠くに離れたら
解放する」という**非対称な閾値**にすることで、400px 〜 3000px の間に「render も unload も起きない
不感帯（デッドゾーン）」ができ、多少行ったり来たりするスクロールでは何も起きない。3000px という値は
「典型的なビューポート高さの数倍」を目安にした経験則で、常時ロードされたままになるページ数を文書全体の
長さに関わらず一定範囲（前後数ページ程度）に抑えられる。

**教訓**: 「近づいたら A する／離れたら B する」という対になる処理を実装するとき、A と B に同じ閾値を
使うと、その閾値ちょうどの位置で状態が微妙に変化するたびに A/B が交互に暴発する（チャタリング）。
複数の `IntersectionObserver` インスタンス（またはヒステリシスのある単一の仕組み）で、閾値そのものを
非対称にして意図的に「どちらも起きない範囲」を作ること。

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
3. `[report.pdf](/attachment/xxx)` 形式の添付リンクに「View PDF」ボタンが付く
4. 画像添付（`.png` 等）や `/attachment/` 配下でないリンクにはボタンが付かない
5. 「View PDF」でリンク直後にビューアが展開され、pdf.js が描画する
6. スクロールに応じて未描画ページが遅延描画される（一括描画されない）
7. ズーム（−/+）でページの拡大縮小と再描画が行われる
8. ページ番号を入力して「移動」すると該当ページへスクロールする
9. ダウンロードボタンで元の添付ファイルを取得できる
10. PDF 内のテキストを選択・コピーできる
11. 「Close PDF」で描画済み内容が破棄されビューアが折りたたまれる
12. 同一ページ内の複数 PDF リンクを同時に展開できる
12a. 長い PDF を下までスクロールしてもツールバーが追従し、ツールバー右端の ✕ ボタンで閉じられる。押すと
    外側の「View PDF」トグルの表示も同期して戻る
12b. 未描画のページにスピナーが表示され、`IntersectionObserver` で描画され次第消える
12c. ツールバーの全ボタン（移動・ズーム・ダウンロード・閉じる）がアイコン表示になっており、ホバーで
    `title` のツールチップが出る
12d. 「View PDF」を押すとビューアがふわっとフェード・スライドしながら展開し、閉じるときも滑らかに消える
    （`prefers-reduced-motion` を有効にしている場合は瞬時に切り替わる）
12e. ツールバーのタイトル表示・ダウンロードボタンの `download` 属性がどちらも元のファイル名そのまま
    （アイコンの `PDF` ラベル文字が混入していない）
12f. GROWI 実機で `.gpv-pdf-link` にマウスホバーすると指カーソル（`cursor: pointer`）になる
13. 編集モードへ遷移するとトグル UI が消え元の `<a>` に戻る。編集モードから戻ると再度ボタンが付く
14. SPA 遷移後の新ページの PDF リンクも自動検出される
15. `/admin` 配下では変換が行われない
16. `.CodeMirror` / `.cm-editor` 配下の PDF リンクには変換が行われない
17. `unmount()` 後、`data-gpv-enhanced` / `gpv-pdf-link` クラス / アイコン / トグルボタンが一切残らず元の
    `<a>` に戻る
18. ダークモード切替（OS / GROWI UI トグルの両方）でツールバー等の配色が同じように適切に変わる
19. 印刷プレビューでツールバーが非表示になる
19a. PDFを展開した状態でしばらく（1〜2秒程度）待ってから印刷プレビューを開くと、スクロールしていない
    後半のページも空白にならず描画された状態で出力される（ハマりどころ #18 の限界内で確認）
20. （S3/GCS Redirect Mode 環境、または Playwright の `page.route().abort()` 等で fetch を失敗させた場合）
    CORS 失敗時に iframe フォールバックへ切り替わり、タイトル・ダウンロードボタン以外のツールバー操作が
    非表示になる
21. `/attachment/xxx#page=5` のようなリンクを展開すると、ページ1ではなく5ページ目が表示された状態で開く
    （ページインジケータも `5 / N` から始まる）
22. 読み込み中に「読み込み中… N%」のようにパーセンテージが表示される（`total` が取得できない環境では
    パーセンテージ無しの「読み込み中…」のみで `NaN%` 等の壊れた表示にならない）
23. 読み込みに1回失敗しても失敗メッセージやボタンは表示されず、自動的にバックグラウンドで再試行する。
    再試行が成功すれば通常のビューアが、再試行も失敗すれば追加のクリック無しで iframe フォールバックが
    表示される（「PDFを表示」を1回押すだけで完結する）
24. 同じ添付PDFを「開く→閉じる」を待ち時間なしで連続して繰り返しても、コンソールにエラーが出ず最終的に
    正しく開ける（Worker破棄の競合が起きない、ハマりどころ #19）
25. モバイル幅（iPhone/Pixel等のビューポート）で横スクロールが発生せず、ツールバーの全ボタンがタップで
    機能する（`.gpv-btn` は34×34px、指での操作を想定したサイズになっている）
26. クロスオリジンCORSブロック（到達はしているが本文が読めない）ではCORSフォールバックのiframeが正常に
    表示される。一方、URL自体が完全に到達不能な場合はiframeを作らず「PDFを表示できませんでした。
    ダウンロードしてご確認ください。」というエラー表示になる（ハマりどころ #21）
27. 多ページのPDFで最後のページまでスクロール（またはページジャンプ）すると、大きく離れた先頭付近の
    ページの canvas が解放され、プレースホルダーの高さは維持されたままスピナー表示に戻る（ハマりどころ
    #22）。そこから元のページまでスクロールで戻ると自動的に再描画される
28. ページの解放・再描画を経てもズームが正しく反映される
29. 一部ページが解放された状態で `beforeprint` を発火させても、解放済みページを含め全ページが強制描画される

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
  - **外部通信**: 外部 URL に対する `fetch` / `XMLHttpRequest` を新規追加していないか（pdf.js が fetch するのは本文中のリンクが指す添付ファイル URL のみ。CDN 依存は禁止）。CORS フォールバックの `<iframe src>` はリンク先への表示専用ナビゲーションであり `fetch`/`XHR` ではないため、この意味での「外部通信の新規追加」には該当しない（[ハマりどころ #8](#8-s3--gcs-redirect-mode-での-cors-失敗--iframe-フォールバック) 参照）。`showFallback()` 内の `fetch(url, {mode:'no-cors'})`（到達可能性プローブ、ハマりどころ #21）も同じ添付ファイル URL のみを対象としており、新規の外部送信先は追加していない。
  - **依存パッケージの脆弱性**: 新規追加した npm パッケージは `pnpm audit` を実行して確認する。
  - **CSP / 外部リソース**: `<script>` / `<link>` を動的挿入して外部ドメインから読み込む実装になっていないか。自己完結なバンドルにすること（pdf.js worker もインライン化済み）。

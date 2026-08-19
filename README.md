# growi-plugin-pdf-viewer

GROWI のページ本文に添付した PDF ファイルへのリンクを、ダウンロードや別タブ遷移ではなく、
**ページ内にインラインで展開表示**する GROWI Script プラグインです。

[pdf.js](https://mozilla.github.io/pdf.js/)（Mozilla 製）を使い canvas に描画するため、ブラウザが PDF を
ネイティブ表示できない環境（一部のモバイルブラウザ等）でも同じ見た目で表示できます。

Markdown レンダラーを拡張するのではなく、GROWI がレンダリング済みの DOM を走査して直接書き換える方式で動作します。

## 使い方

GROWI の添付ファイル機能で PDF をアップロードすると、本文に以下のようなリンクが挿入されます。

```markdown
[report.pdf](/attachment/66dfd1205b6b5996f1b012a7)
```

このリンクのファイル名が `.pdf` で終わっている場合、プラグインがリンクの横に **「PDFを表示」** ボタンを
自動的に追加します。押すとリンクの直後に pdf.js ビューアが展開され、以下の操作ができます。

- **ズーム**（縮小 / 拡大）
- **ページジャンプ**（ページ番号を入力して移動）
- **ダウンロード**（元の添付ファイルを取得）
- **テキスト選択・コピー**（pdf.js の text layer による）

ページは全て一括描画するのではなく、画面に近づいたページだけを遅延描画するため、ページ数が多い PDF でも
初回表示が重くなりにくくなっています。「PDFを閉じる」で描画済みの内容とレンダリングタスクを破棄します。

同一ページ内に複数の PDF リンクがある場合、それぞれ独立して同時に展開できます。

### 対象となるリンク

以下の両方を満たす `<a>` のみが対象です。

- `href` が `/attachment/` から始まる（GROWI の添付ファイルエンドポイント）
- リンクテキスト（表示されているファイル名）が `.pdf` で終わる

外部サイトの PDF リンクや、添付ファイル以外へのリンクは対象になりません。リンクテキストを手動で
`.pdf` 以外に書き換えた場合も検出対象外になります。

### 既知の制約

- GROWI が Amazon S3 / Google Cloud Storage を Redirect Mode で利用している構成では、`/attachment/:id` への
  アクセスが署名付き URL への 302 リダイレクトになる場合があります。バケット側に wiki のオリジンを許可する
  CORS 設定がないと、pdf.js の `fetch` が失敗し「PDFを読み込めませんでした」というエラー表示になります。
  ローカルストレージ構成（同一オリジン）では問題ありません。

## インストール

GROWI 管理画面の `/admin/plugins` からこのリポジトリの URL を指定してインストールしてください。コード更新後に反映させる場合は、トグルの有効/無効切り替えではなく **削除 → 再インストール** が必要です。

## 開発

```bash
pnpm install
pnpm build   # dist/ にビルド成果物を出力
pnpm dev     # Vite の開発サーバーを起動
```

`dist/` はビルド成果物として git にコミットする必要があります。GROWI はプラグインインストール時に `pnpm install` / `pnpm build` を実行せず、リポジトリの `dist/` を静的配信するだけのためです。pdf.js の worker もこの `dist/` の JS バンドルにインライン化されており、外部 CDN には一切依存しません。

## ファイル構成

```
growi-plugin-pdf-viewer/
├── client-entry.tsx              # activate / deactivate + pluginActivators 登録
├── src/
│   ├── pdfViewer.ts               # コア: リンクスキャン・トグル付与・SPA遷移・MutationObserver・cleanup
│   ├── inlineViewer.ts            # 1リンク分のインラインビューア（遅延描画・ズーム・ページジャンプ・text layer）
│   ├── types.ts                   # 共有型定義
│   └── styles/pdfViewer.css       # ビューア・ツールバー・ダークモード・print
├── vite.config.ts
└── dist/                          # ビルド成果物（コミット必須）
```

実装の詳細な設計・既知の注意点は [`CLAUDE.md`](./CLAUDE.md) を参照してください。

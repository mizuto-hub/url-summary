# 要約サービス

URLを入力すると、Webページ全体を読み取り、見出し・本文・リストから要点を拾って約140字でまとめるサービスです。

## 公開URL

https://mizuto-hub.github.io/url-summary/

GitHub Pagesでそのまま動く静的アプリです。`start.cmd` やローカルサーバーの起動は不要です。

## 仕様

- PC / スマートフォン対応のレスポンシブUI
- `http` / `https` のHTMLページに対応
- 見出し、本文、リスト、比較軸、注意点を優先して約140字で要約
- GitHub Pages版ではJina Reader APIでページ本文を取得し、ブラウザ上で要約処理を実行
- 一部サイトは取得制限やCORS制限により読み込めない場合があります

## ローカルで動かす場合

```powershell
node server.js
```

ブラウザで `http://localhost:3000` を開いてください。

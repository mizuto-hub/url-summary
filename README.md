# 140字要約サービス

URLを入力すると、ページ本文を取得して約140字で要約するローカルWebサービスです。外部APIキーやnpmパッケージなしで動きます。

## 起動

Windowsでは `start.cmd` をダブルクリックするか、次のコマンドを実行してください。

```powershell
node server.js
```

ブラウザで `http://localhost:3000` を開いてください。

## 仕様

- `http` / `https` のHTMLページに対応
- `meta description`、見出し、本文から約140字の要約を生成
- localhost やプライベートIPへのアクセスはブロック
- 取得サイズは最大約1.5MB、タイムアウトは12秒

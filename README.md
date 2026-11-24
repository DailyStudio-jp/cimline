# Codex Run Desk

Windows 向けの Codex CLI 管理デスクトップアプリです。Electron のウィンドウに React と shadcn/ui の画面を表示し、複数の `codex exec --json` を2列のターミナルとして並べます。初回起動時に依頼がなければ入力モーダルを開き、各ターミナルから個別の会話を続けられます。左サイドバーの使用量ダイアログでは、Codexアカウントの利用枠の残り割合を先頭に表示し、このアプリで実行したトークン数を集計します。Codexの利用枠情報には正確な残トークン数が含まれないため、残り割合を表示します。完了した依頼は同じCodexスレッドで続けられます。

## 起動

必要なもの:

- Node.js 24 以降
- Codex CLI のインストールとログイン

```powershell
npm install
npm run dev
```

## Windows インストーラー

```powershell
npm run package:win
```

生成物は `release` フォルダーに出力されます。

## Codex CLI の場所

アプリは npm グローバルインストールの `@openai/codex/bin/codex.js` を検索します。標準の Windows npm 配置先は `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js` です。別の場所を使っている場合は起動前に環境変数で指定できます。

```powershell
$env:CODEX_CLI_JS = "C:\path\to\codex.js"
$env:CODEX_NODE_EXE = "C:\Program Files\nodejs\node.exe"
npm run dev
```

実行時はインストール済み Codex CLI のログイン状態、設定、承認ルール、サンドボックスをそのまま使用します。必要なら各依頼で Git worktree を有効にして作業を分離できます。ターミナルを閉じても依頼と会話ログは履歴に残り、あとからターミナルを再表示して同じCodex会話を続けられます。履歴はElectronのユーザーデータ領域に保存します。アプリ終了時に実行中の依頼は停止し、次回起動後に履歴から再開できます。最近のフォルダーはアプリ内に保存します。

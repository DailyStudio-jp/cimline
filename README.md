# CimLine

Windows 向けの Codex CLI 管理デスクトップアプリです。Electron のウィンドウに React と shadcn/ui の画面を表示し、複数の Codex ターミナルを2列で並べます。初回起動時に依頼がなければ入力モーダルを開き、各ターミナルから個別の会話を続けられます。

使用量ダイアログでは、まず Codex アカウントの5時間枠と週間枠について、使用済み割合とリセット時刻を表示します。その下に、このアプリで実行した Codex スレッドごとの累積 total/input/output tokens を表示します。トークン数は Codex が返す使用量を集計します。app-server 方式は usage 通知ごとに更新し、Git worktree または `CODEX_API_KEY` を使う `codex exec --json` 方式は、usage を含むターン完了イベントを受け取った時点で反映します。Codex アカウント利用枠 API は正確な残りトークン数を返さず使用済み割合を返すため、利用枠は割合で表示します。

サイドバーの「スキル」から、ユーザー (`~/.agents/skills`)、プロジェクト (`<project>/.agents/skills`)、Codex system (`CODEX_HOME/skills/.system`)、`CODEX_HOME/skills`、およびプラグインキャッシュ (`CODEX_HOME/plugins/cache/{marketplace}/{plugin}/{version}/`) にあるスキルを参照できます。プラグインは `plugin.json` または `.codex-plugin/plugin.json` の `skills` 相対パス（文字列または文字列配列）に従い、未指定なら従来の `skills/` フォルダーを参照します。配置形式は[Codex plugin documentation](https://developers.openai.com/plugins/build/plugins)に従います。この画面は一覧表示のみで、スキルのインストールや変更は行いません。完了した依頼は同じ Codex スレッドで続けられます。

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

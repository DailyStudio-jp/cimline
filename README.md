# CimLine

CimLineは、Claude CodeとCodex CLIを独立した実端末セッションで使えるデスクトップアプリです。各ターミナルは`node-pty`とxterm.jsで動作し、通常のシェルと同じようにコマンド入力や承認、CLIのスラッシュコマンドを扱えます。ターミナルをグリッド表示でき、セッション履歴の検索、最近使ったフォルダー、ドラッグによる並べ替えにも対応しています。

Codexアカウントの利用枠（5時間・週間）や、ローカルにインストールされたCodexスキルとプラグインも確認できます。認証情報はCimLineに保存せず、インストール済みCodex CLIの設定を利用します。

## 動作条件

- WindowsまたはmacOS
- `codex`または`claude`のCLIを1つ以上インストールし、サインイン済みであること
- WindowsではPowerShell 7（`pwsh`。ない場合はWindows PowerShellを使用）
- macOSではログインシェル
- ソースから起動する場合はNode.js 24以降とnpmが必要です。起動スクリプトからNode.jsを自動導入できます

## 初回セットアップ

まず、使うCLIを1つ以上インストールしてサインインしてください。公式手順はこちらです。

- [Codex CLIのインストール](https://github.com/openai/codex#installing-and-running-codex-cli)
- [Claude Codeのインストール](https://code.claude.com/docs/en/setup)

CimLineはCLIのインストールやサインインを行いません。

ソースから起動すると、起動スクリプトがNode.js 24以降とnpmを確認します。Node.jsが見つからない場合、WindowsではWinGetでNode.js LTSの導入を試し、macOSではHomebrewでNode.jsを導入します。WinGetではパッケージの確認やシステムの承認が表示されることがあります。macOSではHomebrewがあらかじめインストールされている必要があります。自動導入が使えない場合や失敗した場合は、[Node.js公式ダウンロードページ](https://nodejs.org/en/download/)が開きます。

初回起動時にCimLineの依存パッケージがまだない場合は、起動スクリプトが`npm install`を実行して`node_modules`にダウンロードします。

Node.jsが必要なのはソースから起動するときだけです。パッケージ版の起動にはNode.jsは不要ですが、CodexまたはClaudeのCLIは必要です。

## 開発

手動で起動する場合は、リポジトリのフォルダーで次を実行します。

```sh
npm install
npm run dev
```

Windowsでは[`start-cimline.bat`](./start-cimline.bat)をダブルクリックすると、必要なNode.jsと依存パッケージを確認して開発版を起動します。アプリ起動後、起動用のコンソール画面は閉じます。

macOSではFinderから[`start-cimline.command`](./start-cimline.command)をダブルクリックすると、必要なNode.jsと依存パッケージを確認してターミナル上で開発版を起動します。`electron/main.cjs`または`electron/preload.cjs`を変更した場合は、アプリを完全に終了して再起動してください。Viteのホットリロードは画面部分だけを更新します。

## キーボードショートカット

| キー操作 | 動作 |
| --- | --- |
| `/` | 入力欄やダイアログにフォーカスしていないとき、ターミナル検索にフォーカス |
| Windows：`Ctrl+N`／macOS：`Cmd+N` | 新しいターミナルのダイアログを開く |
| Windows：`Ctrl`+`+`／`-`／`0`、macOS：`Cmd`+`+`／`-`／`0` | 表示を拡大／縮小／リセット |
| Windows：`Ctrl`+マウスホイール、macOS：`Ctrl`または`Cmd`+マウスホイール、ピンチ | ターミナルの列数を1〜6列に変更 |
| ワークスペース内で`Alt`+マウスホイール | ワークスペースをスクロール |
| Windows：`Ctrl+C` | 選択中の文字をコピー。選択がなければCLIへ`Ctrl+C`を送信 |
| Windows：`Ctrl+Shift+C`／`Ctrl+V`／`Ctrl+Shift+V` | 選択範囲をコピー／貼り付け／貼り付け |
| macOS：`Cmd+C`／`Cmd+V` | 選択範囲をコピー／貼り付け。選択がないときの`Cmd+C`は無視 |
| macOS：`Ctrl+C` | CLIへ`Ctrl+C`を送信 |
| 全OS：ターミナルを右クリック | 選択中の文字をコピー。選択がなければ貼り付け |

アプリのショートカット以外のキー入力は、選択中のCLIへ送られます。

## インストーラーの作成

Windows用：

```powershell
npm run package:win
```

macOS用：

```sh
npm run package:mac
```

インストーラーは`release/`に出力されます。`node-pty`はネイティブ依存のため、Electronのアーカイブから展開して使います。ローカルのElectronに合わせてバイナリを再ビルドする場合は、次を実行してください。

```sh
npm run rebuild:native
```

## CLIとシェルの設定

CimLineは既定で`PATH`上の`codex`と`claude`を検出します。起動時に次の環境変数を設定すると、検出するCLIや使用するシェルを変更できます。

| 環境変数 | 用途 |
| --- | --- |
| `CIMLINE_SHELL` | セッションで使うシェルの実行ファイル |
| `CIMLINE_CODEX_CMD` | Codexのコマンド名またはパス |
| `CIMLINE_CLAUDE_CMD` | Claude Codeのコマンド名またはパス |
| `CIMLINE_DEFAULT_PROJECT` | 最初に開くフォルダー。`CODEX_DEFAULT_PROJECT`も使用できます |
| `CODEX_CLI_JS`／`CODEX_NODE_EXE` | 利用枠やスキルの取得に使うCodex CLIのスクリプトとNode.js |

WindowsではPowerShell 7（`pwsh`）を優先し、ない場合はWindows PowerShellを使います。macOSではユーザーのログインシェルを使い、取得できない場合は`/bin/zsh`を使います。新規セッションは選択したフォルダーでCLIを通常起動します。履歴から再開すると、同じフォルダーで`codex resume --last`または`claude --continue`を実行します。

## セッション履歴

ターミナルを閉じるとシェルのプロセスツリーを終了します。フォルダー、CLIの種類、セッション情報はElectronのユーザーデータフォルダーにある`sessions.json`に保存され、履歴から再開または削除できます。CimLine終了時に実行中のPTYも終了し、バックグラウンドでは動き続けません。終了時に開いていたセッションは、次回起動時に新しいシェルからCLIの最新の会話を続ける形で自動的に再開します。同じCLI・同じフォルダーで複数開いていた場合は、前回フォーカスしていたものを優先して1件を再開し、残りは履歴に残します。

## セッション状態と通知

ターミナルの状態は待機中、実行中、完了、承認待ち、終了として管理します。Claude Codeのプロンプト、完了、権限確認、ユーザー入力のイベントは、セッションごとにCimLineのユーザーデータフォルダーへ作成する設定ファイルで取得します。Codexは実行ごとの`notify`設定で完了を通知し、空でない入力を送ると実行中になります。CimLineは`~/.claude/settings.json`や`~/.codex/config.toml`を書き換えません。

フックが送信するのはターミナルIDとイベント名だけです。待ち受けは毎回異なるポートで`127.0.0.1`に限定し、起動ごとのランダムトークン、アクティブなセッションの確認、8 KBのリクエスト上限で保護します。フックの標準入力やCodexのイベント本文は破棄され、プロンプトとターミナル出力はセッション履歴に保存されません。未確認のターミナルで完了または承認待ちになると、フォーカスするまで強調表示して件数を表示します。CimLineがバックグラウンドにあるときはOS通知も表示します。

## スキルとプラグイン

Codexターミナル内の`/`コマンドや`$`によるスキル呼び出しは、Codex CLIが処理します。CimLineのスキル表示では、ローカルのCodexスキルとプラグインのキャッシュを参照します。利用量にはCodexアカウントAPIが返す5時間と週間の使用率・リセット時刻を表示します。このAPIから残りトークン数は取得できません。

## ライセンス

CimLine本体はMIT Licenseで公開しています。詳細は[`LICENSE`](./LICENSE)を確認してください。依存パッケージの解決済みバージョンと、`package-lock.json`に記録されたライセンス表記は[`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md)にまとめています。この一覧はパッケージのメタデータに基づくもので、各ライセンス文書の内容までは確認していません。

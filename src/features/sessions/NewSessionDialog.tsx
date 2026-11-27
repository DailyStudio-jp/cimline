import type { FormEvent, RefObject } from "react";
import { AlertCircle, Check, Code2, Copy, FolderOpen, LoaderCircle, Plus, Sparkles, X } from "lucide-react";
import { ManagedDialog } from "@/components/ui/managed-dialog";
import type { CliKind } from "@/features/sessions/types";

type NewSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dialogRef: RefObject<HTMLDialogElement | null>;
  folderPath: string;
  onFolderPathChange: (path: string) => void;
  folderPathCopied: boolean;
  onFolderPathCopiedChange: (copied: boolean) => void;
  defaultDirectory: string;
  bridgeError: string;
  cliAvailable: Record<CliKind, boolean>;
  selectedCli: CliKind;
  onSelectedCliChange: (cli: CliKind) => void;
  creatingSession: boolean;
  onCopyFolderPath: () => void | Promise<void>;
  onChooseFolder: () => void | Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  getCliDisplayName: (cli: CliKind) => string;
};

export function NewSessionDialog({
  open,
  onOpenChange,
  dialogRef,
  folderPath,
  onFolderPathChange,
  folderPathCopied,
  onFolderPathCopiedChange,
  defaultDirectory,
  bridgeError,
  cliAvailable,
  selectedCli,
  onSelectedCliChange,
  creatingSession,
  onCopyFolderPath,
  onChooseFolder,
  onSubmit,
  getCliDisplayName,
}: NewSessionDialogProps) {
  return (
    <ManagedDialog
      open={open}
      onOpenChange={onOpenChange}
      dialogRef={dialogRef}
      className="app-dialog new-session-dialog"
      initialFocusSelector="#new-session-folder"
    >
      <form className="dialog-card" onSubmit={onSubmit}>
        <div className="dialog-heading">
          <div><div className="dialog-kicker">NEW TERMINAL</div><h2>新しいターミナル</h2><p>フォルダーとCLIを選んで、対話型セッションを開始します。</p></div>
          <button type="button" className="icon-button" aria-label="閉じる" onClick={() => onOpenChange(false)}><X size={17} /></button>
        </div>
        {bridgeError && <div className="inline-error"><AlertCircle size={14} />{bridgeError}</div>}
        <label className="field-label" htmlFor="new-session-folder">作業フォルダー</label>
        <div className="folder-field">
          <FolderOpen size={16} />
          <input
            id="new-session-folder"
            value={folderPath}
            onChange={(event) => {
              onFolderPathChange(event.target.value);
              onFolderPathCopiedChange(false);
            }}
            placeholder={defaultDirectory || "フォルダーを選択"}
            spellCheck={false}
            required
          />
          <button
            type="button"
            className={"folder-copy-button" + (folderPathCopied ? " is-copied" : "")}
            aria-label={folderPathCopied ? "パスをコピーしました" : "パスをコピー"}
            title={folderPathCopied ? "コピー済み" : "パスをコピー"}
            disabled={!folderPath.trim()}
            onClick={() => void onCopyFolderPath()}
          >
            {folderPathCopied ? <Check size={14} /> : <Copy size={14} />}
            {folderPathCopied && <span>コピー済み</span>}
          </button>
          <button type="button" className="outline-button" onClick={() => void onChooseFolder()}>選択</button>
        </div>
        <div className="field-label cli-picker-label">CLI</div>
        <div className="cli-picker">
          <label className={"cli-choice is-codex" + (selectedCli === "codex" ? " is-selected" : "")}>
            <input type="radio" name="cli" value="codex" checked={selectedCli === "codex"} onChange={() => onSelectedCliChange("codex")} />
            <Code2 size={20} /><span><strong>Codex CLI</strong><small>{cliAvailable.codex ? "利用できます" : "インストールされていない可能性があります"}</small></span>
            {selectedCli === "codex" && <Check size={17} />}
          </label>
          <label className={"cli-choice is-claude" + (selectedCli === "claude" ? " is-selected" : "")}>
            <input type="radio" name="cli" value="claude" checked={selectedCli === "claude"} onChange={() => onSelectedCliChange("claude")} />
            <Sparkles size={20} /><span><strong>Claude Code</strong><small>{cliAvailable.claude ? "利用できます" : "インストールされていない可能性があります"}</small></span>
            {selectedCli === "claude" && <Check size={17} />}
          </label>
        </div>
        <div className="dialog-footer">
          <span>{cliAvailable[selectedCli] ? "選択したCLIをシェル内で起動します。" : getCliDisplayName(selectedCli) + "が見つからない場合は環境変数で実行パスを指定できます。"}</span>
          <button type="button" className="text-button" onClick={() => onOpenChange(false)}>キャンセル</button>
          <button type="submit" className="primary-button" disabled={creatingSession || !folderPath.trim()}>{creatingSession ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{creatingSession ? "起動中…" : "作成"}</button>
        </div>
      </form>
    </ManagedDialog>
  );
}

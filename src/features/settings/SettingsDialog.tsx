import type { RefObject } from "react";
import { X } from "lucide-react";
import { ManagedDialog } from "@/components/ui/managed-dialog";
import type { ThemeSetting } from "@/vite-env";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dialogRef: RefObject<HTMLDialogElement | null>;
  themeSetting: ThemeSetting;
  onChooseTheme: (theme: ThemeSetting) => void | Promise<void>;
};

export function SettingsDialog({
  open,
  onOpenChange,
  dialogRef,
  themeSetting,
  onChooseTheme,
}: SettingsDialogProps) {
  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} dialogRef={dialogRef} className="app-dialog settings-dialog">
      <div className="dialog-card">
        <div className="dialog-heading">
          <div>
            <div className="dialog-kicker">CIMLINE</div>
            <h2>設定</h2>
            <p>表示テーマを選べます。拡大率は Ctrl / Cmd + / − で調整、0 でリセットできます。</p>
          </div>
          <button type="button" className="icon-button" aria-label="閉じる" onClick={() => onOpenChange(false)}><X size={17} /></button>
        </div>
        <fieldset className="settings-group">
          <legend>テーマ</legend>
          {([
            ["system", "システムに合わせる", "WindowsまたはmacOSの外観設定を使います。"],
            ["light", "ライト", "明るい配色を使います。"],
            ["dark", "ダーク", "暗い配色を使います。"],
          ] as const).map(([value, label, description]) => (
            <label className={"settings-option" + (themeSetting === value ? " selected" : "")} key={value}>
              <input type="radio" name="theme" value={value} checked={themeSetting === value} onChange={() => void onChooseTheme(value)} />
              <span><strong>{label}</strong><small>{description}</small></span>
            </label>
          ))}
        </fieldset>
      </div>
    </ManagedDialog>
  );
}

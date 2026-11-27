import { useMemo, type RefObject } from "react";
import { CircleDot, LoaderCircle, RefreshCw, X } from "lucide-react";
import { ManagedDialog } from "@/components/ui/managed-dialog";
import type { RateLimits, RateWindow } from "@/features/usage/types";

type UsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dialogRef: RefObject<HTMLDialogElement | null>;
  rateLimits: RateLimits | null;
  loading: boolean;
  error: string;
  onRefresh: () => void | Promise<void>;
};

function resetLabel(timestamp: number | null) {
  if (!timestamp) return "リセット時刻不明";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp * 1000));
}

function windowLabel(window: RateWindow) {
  if (window.windowDurationMins && window.windowDurationMins >= 10000) return "週間枠";
  if (window.windowDurationMins && window.windowDurationMins >= 300) return "5時間枠";
  return "利用枠";
}

export function UsageDialog({ open, onOpenChange, dialogRef, rateLimits, loading, error, onRefresh }: UsageDialogProps) {
  const rateWindows = useMemo(() => rateLimits
    ? [rateLimits.primary, rateLimits.secondary].filter((item): item is RateWindow => Boolean(item))
      .sort((left, right) => (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER))
    : [], [rateLimits]);

  return (
    <ManagedDialog open={open} onOpenChange={onOpenChange} dialogRef={dialogRef} className="app-dialog usage-dialog">
      <div className="dialog-card">
        <div className="dialog-heading">
          <div><div className="dialog-kicker">CODEX CLI</div><h2>使用量</h2><p>Codex CLIの5時間枠・週間枠を表示します。Claude Codeは対象外です。</p></div>
          <div className="dialog-heading-actions">
            <button className="icon-button" type="button" aria-label="利用枠を更新" title="利用枠を更新" onClick={() => void onRefresh()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
            <button type="button" className="icon-button" aria-label="閉じる" onClick={() => onOpenChange(false)}><X size={17} /></button>
          </div>
        </div>
        {loading && !rateLimits ? <div className="dialog-state"><LoaderCircle size={16} className="spin" />利用枠を取得しています…</div> : rateWindows.length ? <div className="rate-window-list">{rateWindows.map((window, index) => {
          const used = Math.max(0, Math.min(100, window.usedPercent));
          const remaining = 100 - used;
          const kind = used >= 90 ? " is-critical" : used >= 70 ? " is-warning" : "";
          return <section className={"rate-window" + kind} key={window.windowDurationMins || index}>
            <div className="rate-window-heading"><span>{windowLabel(window)}</span><strong>{Math.round(remaining)}% <small>残り</small></strong></div>
            <div className="rate-window-track"><span style={{ width: used + "%" }} /></div>
            <div className="rate-window-foot"><span>{Math.round(used)}% 使用済み</span><small>リセット {resetLabel(window.resetsAt)}</small></div>
          </section>;
        })}</div> : <div className="dialog-state is-error">{error || "利用枠の情報を取得できませんでした。"}</div>}
        <div className="usage-note"><CircleDot size={12} />Codex CLIの5時間・週間利用枠を表示しています。</div>
      </div>
    </ManagedDialog>
  );
}

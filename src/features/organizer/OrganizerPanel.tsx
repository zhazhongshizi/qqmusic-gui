import { useEffect, useMemo, useState } from "react";

import {
  executeOrganizer,
  LibraryAdapterError,
  previewOrganizer,
} from "../../backend/libraryAdapter";
import type {
  OrganizerExecution,
  OrganizerOperation,
  OrganizerPreview,
  OrganizerSelection,
  PlaylistSummary,
} from "../../contracts/library";

interface OrganizerPanelProps {
  readonly playlists: readonly PlaylistSummary[];
  readonly previewRuntime: boolean;
}

const OPERATION_LABELS: Record<OrganizerOperation, string> = {
  copy: "复制到目标歌单",
  move: "移动到目标歌单",
  remove: "从源歌单移除",
  deduplicate: "按歌曲 ID 去重",
};

const SELECTION_LABELS: Record<OrganizerSelection, string> = {
  all: "全部歌曲",
  duplicates: "重复项",
  intersection: "两个歌单的交集",
  difference: "源歌单独有项",
};

function publicError(error: unknown) {
  if (!(error instanceof LibraryAdapterError)) return "整理计划暂时不可用。";
  switch (error.code) {
    case "QMG-LIBRARY-AUTH": return "请先扫码登录，再读取账号歌单。";
    case "QMG-LIBRARY-DRIFT": return "歌单内容已经变化，请重新预览。";
    case "QMG-LIBRARY-EXPIRED": return "计划已过期，请重新生成预览。";
    case "QMG-LIBRARY-UNKNOWN": return "写入结果待核对；应用没有自动重复提交。";
    default: return "整理计划暂时不可用，请稍后重试。";
  }
}

export function OrganizerPanel({ playlists, previewRuntime }: OrganizerPanelProps) {
  const [operation, setOperation] = useState<OrganizerOperation>("copy");
  const [selection, setSelection] = useState<OrganizerSelection>("all");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<OrganizerPreview | null>(null);
  const [execution, setExecution] = useState<OrganizerExecution | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "executing" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!sourceId && playlists[0]) setSourceId(playlists[0].id);
    if (!targetId) {
      const target = playlists.find((playlist) => playlist.id !== (sourceId || playlists[0]?.id));
      if (target) setTargetId(target.id);
    }
  }, [playlists, sourceId, targetId]);

  useEffect(() => {
    if (operation === "deduplicate") setSelection("duplicates");
    setPreview(null);
    setExecution(null);
    setConfirmed(false);
  }, [operation]);

  const needsTarget = operation === "copy" || operation === "move" || selection === "intersection" || selection === "difference";
  const source = useMemo(() => playlists.find((playlist) => playlist.id === sourceId), [playlists, sourceId]);
  const target = useMemo(() => playlists.find((playlist) => playlist.id === targetId), [playlists, targetId]);
  const canPreview = !previewRuntime && source?.editableId && (!needsTarget || (target?.editableId && target.id !== source.id));

  async function handlePreview() {
    if (!canPreview || !source?.editableId) return;
    setStatus("loading");
    setMessage("");
    setPreview(null);
    setExecution(null);
    setConfirmed(false);
    try {
      const result = await previewOrganizer({
        operation,
        source: { id: source.id, editableId: source.editableId },
        ...(needsTarget && target?.editableId
          ? { target: { id: target.id, editableId: target.editableId } }
          : {}),
        selection,
        selectedSongIds: [],
      });
      setPreview(result);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setMessage(publicError(error));
    }
  }

  async function handleExecute() {
    if (!preview || !confirmed) return;
    setStatus("executing");
    setMessage("");
    try {
      const result = await executeOrganizer(preview.planId);
      setExecution(result);
      setStatus("idle");
      setConfirmed(false);
    } catch (error) {
      setStatus("error");
      setMessage(publicError(error));
    }
  }

  if (previewRuntime) {
    return (
      <div className="organizer-empty">
        <strong>本地预览不会生成可执行计划</strong>
        <p>在 Windows 桌面端登录后，这里会读取真实歌单快照；任何修改都必须先生成预览。</p>
      </div>
    );
  }

  if (playlists.length === 0) {
    return (
      <div className="organizer-empty" role="status">
        <strong>还没有可整理的自建歌单</strong>
        <p>请先登录并创建至少一个歌单；复制或移动需要两个自建歌单。</p>
      </div>
    );
  }

  return (
    <div className="organizer-panel">
      <div className="organizer-controls">
        <label>
          <span>操作</span>
          <select value={operation} onChange={(event) => setOperation(event.currentTarget.value as OrganizerOperation)}>
            {Object.entries(OPERATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>源歌单</span>
          <select value={sourceId} onChange={(event) => { setSourceId(event.currentTarget.value); setPreview(null); }}>
            {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title} · {playlist.songCount} 首</option>)}
          </select>
        </label>
        {needsTarget ? (
          <label>
            <span>目标歌单</span>
            <select value={targetId} onChange={(event) => { setTargetId(event.currentTarget.value); setPreview(null); }}>
              {playlists.filter((playlist) => playlist.id !== sourceId).map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title} · {playlist.songCount} 首</option>)}
            </select>
          </label>
        ) : null}
        <label>
          <span>范围</span>
          <select
            disabled={operation === "deduplicate"}
            value={selection}
            onChange={(event) => { setSelection(event.currentTarget.value as OrganizerSelection); setPreview(null); }}
          >
            {Object.entries(SELECTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button
          className="text-button text-button--primary"
          disabled={!canPreview || status === "loading" || status === "executing"}
          onClick={() => void handlePreview()}
          type="button"
        >
          {status === "loading" ? "正在读取快照…" : "生成整理预览"}
        </button>
      </div>

      {message ? <p className="organizer-message" role="alert">{message}</p> : null}

      {preview ? (
        <section className="organizer-preview" aria-labelledby="organizer-preview-title">
          <header>
            <div>
              <span className="section-label">REVIEW PLAN</span>
              <h2 id="organizer-preview-title">将处理 {preview.itemCount} 首歌曲</h2>
              <p>{preview.sourceTitle}{preview.targetTitle ? ` → ${preview.targetTitle}` : ""} · {OPERATION_LABELS[preview.operation]}</p>
            </div>
            <span className="quality-tag">15 分钟内有效</span>
          </header>
          <ol>
            {preview.items.map((item) => (
              <li key={item.id}><strong>{item.title}</strong><span>{item.artist} · {item.album}</span></li>
            ))}
          </ol>
          {preview.previewTruncated ? <p>仅展示前 100 项；执行仍以此预览绑定的完整计划为准。</p> : null}
          <label className="organizer-confirm">
            <input checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} type="checkbox" />
            <span>我已核对源、目标与曲目数量，确认执行这个计划</span>
          </label>
          <button
            className="text-button text-button--primary"
            disabled={!confirmed || status === "executing"}
            onClick={() => void handleExecute()}
            type="button"
          >
            {status === "executing" ? "正在逐项执行与对账…" : `确认执行 ${preview.itemCount} 项`}
          </button>
        </section>
      ) : null}

      {execution ? (
        <div className="organizer-result" role="status">
          <strong>{execution.state === "complete" ? "整理完成" : "整理完成，但仍有项目需要核对"}</strong>
          <p>成功 {execution.completedCount} / {execution.itemCount} · 失败 {execution.failedCount} · 待核对 {execution.pendingVerificationCount}</p>
        </div>
      ) : null}
    </div>
  );
}

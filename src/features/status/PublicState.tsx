import { useEffect, useRef } from "react";

export type FixtureStatus =
  | "normal"
  | "loading"
  | "empty"
  | "partial"
  | "error"
  | "unauthenticated";

interface PublicStateProps {
  focusOnMount?: boolean;
  kind: Exclude<FixtureStatus, "normal">;
  onAction?: () => void;
}

const COPY = {
  empty: {
    eyebrow: "曲库",
    title: "这里还没有歌曲",
    body: "搜索一首歌，或登录后把喜欢的音乐带到这里。",
    action: "前往搜索",
  },
  error: {
    eyebrow: "连接未完成",
    title: "暂时无法读取音乐服务",
    body: "本地队列仍然保留。请检查网络后重试；若问题持续，可复制诊断编号。",
    action: "重试",
  },
  unauthenticated: {
    eyebrow: "账号",
    title: "登录后查看你的音乐",
    body: "使用 QQ 或微信扫码。二维码只在本次登录期间保留。",
    action: "继续使用本地队列",
  },
} as const;

export function PublicState({ focusOnMount = false, kind, onAction }: PublicStateProps) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const stateRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!focusOnMount || kind === "partial") return;
    (actionRef.current ?? stateRef.current)?.focus();
  }, [focusOnMount, kind]);

  if (kind === "partial") {
    return (
      <aside className="partial-notice" role="status">
        <span aria-hidden="true" className="partial-notice__mark">!</span>
        <p><strong>已显示可用内容</strong> · 2 个推荐区块暂时未能加载。</p>
        <button onClick={onAction} type="button">知道了</button>
      </aside>
    );
  }

  if (kind === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label="正在载入内容"
        className="public-state public-state--loading"
        ref={stateRef}
        tabIndex={-1}
      >
        <div className="loading-glyph" aria-hidden="true"><span /><span /><span /></div>
        <p>正在整理唱片目录…</p>
      </section>
    );
  }

  const copy = COPY[kind];

  return (
    <section
      className={`public-state public-state--${kind}`}
      ref={stateRef}
      role={kind === "error" ? "alert" : "status"}
      tabIndex={-1}
    >
      <span className="section-label">{copy.eyebrow}</span>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <div className="public-state__actions">
        <button
          className="text-button text-button--primary"
          onClick={onAction}
          ref={actionRef}
          type="button"
        >
          {copy.action}
        </button>
        {kind === "error" ? <code>QMG-CATALOG-042</code> : null}
      </div>
    </section>
  );
}

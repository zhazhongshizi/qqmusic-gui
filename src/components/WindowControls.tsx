import { useEffect, useState } from "react";
import {
  listenWindowResize,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from "../backend/windowAdapter";
import { Icon } from "./Icon";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void windowIsMaximized().then((isMax) => {
      if (active) setMaximized(isMax);
    });

    void listenWindowResize((isMax) => {
      if (active) setMaximized(isMax);
    }).then((cleanup) => {
      if (active) {
        unlisten = cleanup;
      } else {
        cleanup();
      }
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return (
    <div aria-label="窗口控制" className="window-controls" role="group">
      <button
        aria-label="最小化"
        className="window-control-button"
        data-tauri-drag-region="false"
        onClick={() => void windowMinimize()}
        title="最小化"
        type="button"
      >
        <Icon name="minimize" size={14} />
      </button>
      <button
        aria-label={maximized ? "向下还原" : "最大化"}
        className="window-control-button"
        data-tauri-drag-region="false"
        onClick={() => void windowToggleMaximize()}
        title={maximized ? "向下还原" : "最大化"}
        type="button"
      >
        <Icon name={maximized ? "restore" : "maximize"} size={13} />
      </button>
      <button
        aria-label="关闭"
        className="window-control-button window-control-button--close"
        data-tauri-drag-region="false"
        onClick={() => void windowClose()}
        title="关闭"
        type="button"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

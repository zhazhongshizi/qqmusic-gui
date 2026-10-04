import { Component, type ReactNode } from "react";

/** Keep the shared player alive when an optional visual mode cannot load. */
export class ModeLoadBoundary extends Component<{ children: ReactNode; onExit: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <section role="alert"><p>莱茵界面加载失败，当前播放继续。</p><button onClick={this.props.onExit}>返回主界面</button></section> : this.props.children;
  }
}

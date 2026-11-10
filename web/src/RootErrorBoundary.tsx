/**
 * 根错误边界:一次渲染异常不许把整个页面端了,更不许不留证据。
 *
 * 踩过的坑(2026-08-29):知识清单里点某一行就白屏。React 未捕获的渲染
 * 异常会卸载整棵树,页面变纯白——没有报错、没有堆栈、没有可点的东西,
 * 用户只能说"卡死了",排障得靠他自己去翻 F12。全仓当时只有
 * LaunchWorkspace 里一个局部边界,它管不到别处。
 *
 * 这里只做两件事:把页面稳住(还能刷新、还能看见自己在哪),把真相摆出来
 * (错误原文 + 组件栈,可一键复制)。它不替任何人"修复"异常,也不重试——
 * 掩盖一次渲染错误比白屏更坏。
 *
 * 唯一的例外(2026-09-08):chunk 加载失败——发版前开的标签页揣着旧
 * chunk 名,点懒加载页签时服务器上已是新哈希,404 是运行时陈旧而非
 * 代码缺陷,刷新即愈。识别到就自动整页刷新一次(30s 窗口防打转:部署
 * 真缺文件时,第二次失败照常落错误卡)。其余渲染异常维持原立场。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

/** 同一类失败在不同浏览器的话术:Chromium / Firefox / Safari。 */
const CHUNK_LOAD_ERROR = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;
const CHUNK_RELOAD_KEY = "mfc-chunk-reload-at";
const CHUNK_RELOAD_WINDOW_MS = 30_000;

interface RootErrorState {
  error?: Error;
  componentStack?: string;
}

export class RootErrorBoundary extends Component<
  { children: ReactNode }, RootErrorState
> {
  state: RootErrorState = {};

  static getDerivedStateFromError(error: Error): RootErrorState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台仍要留一份:开发者习惯先看 F12,别逼他从页面上抄。
    console.error("[app] 页面渲染失败", error, info);
    // 陈旧标签页跨发版:自动刷新拿新入口,用户无感。窗口期内不重复刷
    // (刷新是整页导航,正常情况下也不会在 30s 内回到同一棵渲染树)。
    if (CHUNK_LOAD_ERROR.test(error.message)) {
      const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
      if (Date.now() - last > CHUNK_RELOAD_WINDOW_MS) {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
        location.reload();
        return;
      }
    }
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  private report(): string {
    const { error, componentStack } = this.state;
    return [
      `错误:${error?.name ?? "Error"}: ${error?.message ?? "未知错误"}`,
      error?.stack ? `\n调用栈:\n${error.stack}` : "",
      componentStack ? `\n组件栈:${componentStack}` : "",
      `\n页面:${location.pathname}${location.search}`,
      `时间:${new Date().toISOString()}`,
    ].filter(Boolean).join("\n");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // 皮(#233 收官):原 rootError.css 换装为工具类,该文件已退役。
    return <div className="grid min-h-screen place-items-center bg-canvas px-5 py-8" role="alert">
      <div className="grid w-full max-w-[760px] gap-3 rounded-xl border border-line border-l-4 border-l-danger bg-surface p-6">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-primary">PAGE ERROR</span>
        <h1 className="m-0 text-lg font-bold text-text-strong">页面出错了，不是你的操作有问题</h1>
        <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
          界面某一处渲染失败。你的数据没有丢——服务端状态不受影响，
          刷新后可以继续。下面是给排查用的原文，请连同「你刚点了什么」
          一起反馈。
        </p>
        <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text">{this.report()}</pre>
        <div className="flex gap-2.5">
          <button type="button" className="cursor-pointer rounded-lg border border-line bg-surface-2 px-4 py-2 text-[13px] text-text-strong transition-colors hover:border-primary" onClick={() => location.reload()}>
            刷新页面
          </button>
          <button type="button" className="cursor-pointer rounded-lg border border-line bg-surface-2 px-4 py-2 text-[13px] text-text-strong transition-colors hover:border-primary" onClick={() => {
            // 内网 http 下 clipboard API 可能不可用;失败就让用户手选,
            // 不弹错误盖住正文。
            void navigator.clipboard?.writeText(this.report()).catch(
              () => undefined);
          }}>复制错误详情</button>
        </div>
      </div>
    </div>;
  }
}

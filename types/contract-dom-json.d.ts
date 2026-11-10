// 契约程序的类型钉(tsconfig.contract.json 专用)。
// contract 程序 = lib 带 DOM + types 带 node:@types/node(undici)的全局
// Response 与 lib DOM 合并后,json() 的重载链落到 undici 的 unknown,而
// web/src/api.ts 按 DOM 语义书写(response.json() 直接返回载荷)。这里
// 用全局扩展把 json() 钉回 any,与纯 DOM 环境同一推断;只影响本程序,
// 根程序(无 DOM)不吃这个文件。
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
export {};

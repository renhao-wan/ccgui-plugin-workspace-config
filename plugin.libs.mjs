// 本插件参与内联的库清单——build 与 validate 共用这一份。
// 顺序即内联顺序：有依赖的必须排在前面。
// 来源不用写：先按共用包的 exports 解析，解析不到再读 src/lib/<name>.mjs。
export default ["model", "feedback", "feedback-net", "feedback-ui", "markdown", "markdown-view", "dropdown"];

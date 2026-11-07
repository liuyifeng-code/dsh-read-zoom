// 放大阅读（dsh-read-zoom）— 浏览器半。
//
// 整个功能都在浏览器侧完成（纯 DOM：悬停药丸按钮 + 全屏阅读浮层），
// Host 侧故意不注册任何服务 / 路由：本地插件的 Host 半一旦注册了坏路由
// 会拖垮整个 web boot（见 dsh-cmd-watch 的注释教训）。
export function apply() {}

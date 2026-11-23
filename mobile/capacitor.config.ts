import type { CapacitorConfig } from "@capacitor/cli";

// 手机端 Capacitor 配置。
// 说明：这个 App 是个“启动器壳”，不是把 Nyra 搬进手机——agent 在云端跑
//（第 6 批，见 docs/mobile-cloud.md）。壳里只装一张静态启动页
//（www/index.html），主入口是账号登录：用户填云端地址、点登录按钮打开
// 云端登录页；局域网表单退到了启动器页底部的“旧版”折叠区。所以不需要
// server.url（云端地址由用户在启动器页里填一次、存在 localStorage，
// 写死在配置里没有意义），也不需要任何 Capacitor 插件。
const config: CapacitorConfig = {
  appId: "dev.nyra.mobile",
  appName: "Nyra",
  webDir: "www",
  backgroundColor: "#0B0B0C",
};

export default config;

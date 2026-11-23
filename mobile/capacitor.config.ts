import type { CapacitorConfig } from "@capacitor/cli";

// 手机端 Capacitor 配置。
// 说明：这个 App 是个“启动器壳”，不是把 Nyra 搬进手机。壳里只装一张静态启动页
//（www/index.html，由 www/index.src.html 经 scripts/make-assets.ts 生成）：登录首屏（方块头 + 标语，
// 账号登录按钮在但标“即将推出”——云端登录后端还没部署）和“连家里电脑”（局域网 + 配对码，跳电脑上的 /m）。
// 不需要 server.url（地址由用户在启动器页里填一次、存在 localStorage），也不需要任何 Capacitor 插件。
// backgroundColor = 原生启动图与开机动画的底色 #1a1a1a：启动图 → 启动器页 → /m 一路不跳白。
const config: CapacitorConfig = {
  appId: "dev.nyra.mobile",
  appName: "Nyra",
  webDir: "www",
  backgroundColor: "#1a1a1a",
};

export default config;

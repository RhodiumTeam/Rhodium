# 网页终端：自己画，接 Herdr 的公开命令，用 ghostty-web

这篇回答：网页里的终端怎么连到 Herdr 的 pane，画终端用哪个组件，为什么不用现成的 herdr-web（一个第三方的 Herdr 网页终端）。

前置阅读：[术语表](../../GLOSSARY.md)、[产品说明](../product.md)、[ADR-0010](0010-herdr-hosts-tui.md)

状态：已接受（2026-10-24）

[网页终端](../../GLOSSARY.md)由 Rhodium 自己画。看板为它起一个 Herdr 公开的 `herdr terminal session control <pane> --takeover`，经一条同源的 WebSocket 把画面转给页面，把页面的按键、尺寸、滚动转给 Herdr。画终端用 ghostty-web，不用 xterm.js。

## 为什么自己画，不用 herdr-web

herdr-web 是第三方的实验项目，它的页面和桥都不合用：

- **它的桥走 Herdr 的私有协议。** 只认一个协议号，Herdr 一改协议就要等它先出新版。ADR-0010 定的就是只用公开接口，而 Herdr 的私有终端协议 3 个月里变了 4 次。
- **它嵌不进来。** 它自己回 `X-Frame-Options: DENY` 和 `frame-ancestors 'none'`，也没有按 pane 打开的地址。
- **它不认人。** 它只挡别的网站借你的浏览器连进来，不看你的 Tailscale 账号。
- **它让所有浏览器共用一个操作者。** 谁都能打字，尺寸最后一个说了算。我们要的是同一时刻只有一处在操作。

`terminal session control` 是 Herdr 0.7.2 起专门给“桥”用的公开命令，写在它的命令行文档里，ADR-0010 当时就点名了它。同一个终端只能有一个操作者，这条规矩由 Herdr 管，herdr-web 也受它管（2026-10-24 本机实测）。

herdr-web 在手机输入上做得好的地方（一排键、输入框、输入法）只学思路。

## 为什么用 ghostty-web

- **和直接用 Herdr 一样。** ghostty-web 是 Ghostty 的终端内核编译成 WebAssembly。Herdr 自己的终端引擎也是 Ghostty，所以两边解析同一串画面的结果一样。herdr-web 用它跑 Herdr 的画面，已经用了几个版本。
- **字宽一致。** 中文、emoji 占一格还是两格，两边按同一套规则算。xterm.js 用自己的表，和 Herdr 算得不一样时，光标会错位，画面一行行歪掉。手机上中文多，这一点最要紧。

## 考虑过的其他方案

- **xterm.js。** 包小一半（gzip 约 90KB，ghostty-web 约 190KB），看板的 CSP 不用改。但字宽有上面的风险，画面也不是 Herdr 那套引擎。
- **把 herdr-web 的页面搬进来，看板转发它的桥。** 手机输入现成最好。但它的终端组件两千多行，绑着它自己的状态和设置；私有协议的升级问题也一起背上；还要改它“大家共用一个操作者”的做法。
- **iframe 嵌 herdr-web。** 走不通，原因见上。

## 后果

- 看板 HTML 的 CSP 在 `script-src` 里加 `'wasm-unsafe-eval'`，别的不加。它让页面能跑 WebAssembly，不放开内联脚本和 `eval`。CSP 是整个页面一份，所以看板的每一页都带它。
- ghostty-web 只在网页终端里按需加载。看板首屏、对话页那一包都不含它。
- ghostty-web 还没到 1.0（写死 0.4.0）。herdr-web 绕过它几处毛病，其中一处是空闲时也一直跑动画帧，费电。用着有问题，照 herdr-web 的办法绕。
- 只跟 Herdr 的公开命令。Herdr 改这条命令的格式，会写进它的更新记录。
- 看板只开得了槽位的 pane。不是槽位的 pane，先用 `rh import` 导成槽位。

# World Clash 🌍🚗💨

Game for fun — **World Clash**（`rooftop-bumpers/`）。

👉 **Live Demo**: <https://app-worldclash-dev-39ca.azurewebsites.net/> — *Feel free to try it, very fun!*

这是一个突发奇想的 idea，大概花了 15 分钟做出来的原型。原本试着把它做成不同国家实时在线物理对战，但发现跨地域互联网延迟依然是强耦合碰撞体验的物理阻碍（Internet latency is still a thing blocking the real-time collision experience），因此最终改为**本地优先的 10 车单机混战 + 全球国家积分实时联网同步排行榜**，兼顾零延迟丝滑手感与为国争光的刷分乐趣。

## Azure Deployment Target

- **Resource Group**: `rg-worldclash-dev-39ca` (`eastasia`)
- **App Service**: `app-worldclash-dev-39ca` (Plan: `asp-worldclash-dev-39ca`, F1 Free)
- **Infra Templates**: [`infra/`](./infra/)

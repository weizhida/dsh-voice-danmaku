---
name: Bug 报告
about: 插件不工作、行为异常、崩溃
title: '[Bug] '
labels: bug
---

## 发生了什么

<!-- 你期望的行为 vs 实际发生的行为 -->

## 复现步骤

1.
2.
3.

## 环境

| 项 | 值 |
|---|---|
| Windows 版本 | <!-- winver 里能看到，如 Windows 11 23H2 --> |
| DSH 版本 | <!-- dsh --version --> |
| 插件版本 | <!-- package.json 里的 version --> |
| Node 版本 | <!-- node --version --> |
| ffmpeg | <!-- ffmpeg -version 的第一行，或"未安装" --> |

## 哪一步卡住了

<!-- 勾选最接近的一项，这决定了我该从哪一层查 -->

- [ ] 设置界面里根本看不到「语音弹幕」这一节（插件没加载）
- [ ] 按 F9 没有任何反应（可能是钩子被游戏挡住，或 sidecar 没起来）
- [ ] 浮层出现了但看不到 / 被游戏盖住
- [ ] 浮层显示的文字不对
- [ ] 识别失败（报错信息是什么？）
- [ ] 弹幕发送失败（服务端返回的 code 是什么？）
- [ ] 其他

## 日志

**这一项通常比前面的描述更有用。** 插件把诊断信息写到 stderr，
原生层单独写一份日志：

```powershell
# sidecar 的原生日志（记录了钩子安装、进程生命周期）
Get-ChildItem "$env:TEMP\dsh-voice-danmaku\*.log" | Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 | Get-Content -Tail 40
```

<details>
<summary>粘贴日志</summary>

```
（在这里粘贴）
```

</details>

## 如果你跑了真机验证

```powershell
npm run verify:hotkey
```

请在游戏里按一次 F9，然后把 `.verify/` 下最新的那个文件内容贴上来
（它记录了按键是否被捕获、以及当时的前台窗口是哪个进程）。

> ⚠️ 贴日志前请检查并删掉任何 `SESSDATA`、`bili_jct`、API 密钥。
> 这些等同于你的登录态。

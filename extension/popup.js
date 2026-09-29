/**
 * 扩展弹窗：填本地桥的端口与口令，顺便测一下连没连上。
 *
 * 「保存并测试连接」把两件事合成一步是刻意的：用户来这里就是为了"让它通"，
 * 让他先保存、再自己去别处看状态，等于把一次操作拆成两次。
 */

'use strict';

const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const saveButton = document.getElementById('save');
const statusBox = document.getElementById('status');

function setStatus(text, kind) {
  statusBox.textContent = text;
  statusBox.className = kind ?? '';
}

/** 向后台要一次桥的状态，并把结论说成人话。 */
async function testConnection() {
  setStatus('正在测试…');
  const reply = await chrome.runtime.sendMessage({ cmd: 'status' });
  if (reply === null || reply === undefined || reply.ok !== true) {
    setStatus(`✗ ${reply?.message ?? '插件没有响应'}`, 'bad');
    return;
  }

  const snapshot = reply.snapshot ?? {};
  const lines = [];
  lines.push(`✓ 本地桥可达（端口 ${snapshot.port}）`);
  // lastSeenAt 是毫秒时间戳，0 表示"从没来过"。
  if (typeof snapshot.lastSeenAt === 'number' && snapshot.lastSeenAt > 0) {
    const ago = Math.round((Date.now() - snapshot.lastSeenAt) / 1000);
    lines.push(`✓ 这个浏览器已经在轮询（${ago} 秒前）`);
  } else {
    lines.push('… 还没开始轮询：请打开一个 B 站直播间页面');
  }

  const page = snapshot.page;
  if (page !== undefined && page !== null) {
    lines.push(page.hasInput && page.hasButton
      ? `✓ 页面就绪：${page.title || page.href}`
      : `✗ 页面里没找到${page.hasInput ? '' : '输入框'}${page.hasButton ? '' : '发送按钮'}：${page.href}`);
    if (typeof page.error === 'string' && page.error.length > 0) lines.push(`最近一次错误：${page.error}`);
  }
  setStatus(lines.join('\n'), 'ok');
}

async function load() {
  const reply = await chrome.runtime.sendMessage({ cmd: 'settings' });
  const settings = reply?.settings ?? { port: 39217, token: '' };
  portInput.value = String(settings.port);
  tokenInput.value = String(settings.token);
  if (String(settings.token).length === 0) {
    setStatus('还没填口令。在插件设置页里复制「本地桥口令」粘贴到这里。');
    return;
  }
  await testConnection();
}

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  await chrome.runtime.sendMessage({
    cmd: 'save',
    port: Number(portInput.value) || 39217,
    token: tokenInput.value.trim()
  });
  saveButton.disabled = false;
  await testConnection();
});

void load();

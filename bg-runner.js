#!/usr/bin/env node
/**
 * bg-tasks 执行器（2026-11-02）：独立常驻进程，与 bot.js / claude 一次性进程生命周期完全解耦。
 *
 * 用法：node bg-runner.js <taskDir>
 * 约定（与 bot.js 扫描器配套）：
 *   <taskDir>/task.json    任务单：{ id, title, script, args?, timeoutMinutes?, notifyChatId? }
 *   <taskDir>/<script>     自包含脚本（py/js），凭据/轮询/执行/验证/日志全在内部
 *   <taskDir>/task.log     执行日志（stdout/stderr 镜像 + 执行器事件）
 *   <taskDir>/status.json  状态机：pending → running → done | error（含 summary）
 *
 * 环境：继承 bot.js 注入的 LARKSUITE_CLI_CONFIG_DIR / HTTPS_PROXY / PATH（含 npm 全局目录），
 *       结束后用 lark-cli 直接给 notifyChatId 发飞书通知。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const taskDir = path.resolve(process.argv[2]);
const taskFile = path.join(taskDir, 'task.json');
const statusFile = path.join(taskDir, 'status.json');
const logFile = path.join(taskDir, 'task.log');

function writeStatus(obj) {
  fs.writeFileSync(statusFile, JSON.stringify({ ...obj, updatedAt: new Date().toISOString() }, null, 2));
}
function log(line) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

(async () => {
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  const id = task.id || path.basename(taskDir);
  const script = path.resolve(taskDir, task.script || 'run.py');
  if (!fs.existsSync(script)) throw new Error(`脚本不存在: ${script}`);
  const timeoutMs = Math.min(task.timeoutMinutes || 720, 7 * 24 * 60) * 60_000; // 上限 7 天
  const startedAt = Date.now();
  writeStatus({ state: 'running', id, title: task.title || id, startedAt: new Date(startedAt).toISOString() });
  log(`任务启动: ${task.title || id} | 脚本=${script} | 超时=${Math.round(timeoutMs / 60000)} 分钟`);

  const isPy = script.toLowerCase().endsWith('.py');
  const childEnv = isPy ? { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } : process.env; // 防 GBK 乱码（AGENTS.md 排查纪律同款教训）
  const child = spawn(isPy ? 'python' : process.execPath, [script, ...(task.args || [])], {
    cwd: taskDir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
  });
  let outTail = '';
  const remember = d => { outTail = (outTail + d).slice(-1500); };
  child.stdout.on('data', d => { const s = String(d); log(s.trimEnd()); remember(s); });
  child.stderr.on('data', d => { const s = String(d); log('[stderr] ' + s.trimEnd()); remember(s); });

  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ code: -1, timeout: true }); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code == null ? -3 : code }); });
    child.on('error', err => { clearTimeout(timer); resolve({ code: -2, error: err.message }); });
  });

  const ok = result.code === 0;
  writeStatus({
    state: ok ? 'done' : 'error', id, title: task.title || id,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    exitCode: result.code,
    ...(result.timeout ? { timeout: true } : {}),
    ...(result.error ? { spawnError: result.error } : {}),
    summary: outTail.slice(-400),
  });
  log(`任务结束: state=${ok ? 'done' : 'error'} exit=${result.code}${result.timeout ? ' (超时强杀)' : ''} 耗时=${fmtDur(Date.now() - startedAt)}`);

  // 飞书回传：detached 模式下这是结果送达的唯一通道，失败必须留在日志里可追查
  const chatId = task.notifyChatId;
  if (!chatId) { log('未配置 notifyChatId，跳过飞书通知'); return; }
  const head = ok ? '✅ 后台任务完成' : '❌ 后台任务失败';
  const text = `${head}\n**任务**：${task.title || id}\n**耗时**：${fmtDur(Date.now() - startedAt)}`
    + (result.timeout ? '\n**注意**：已超时强制终止' : '')
    + `\n\n${(outTail.slice(-300) || '(脚本无输出)').replace(/```/g, '` ` `')}`
    + `\n\n日志文件：${logFile}`;
  await new Promise(resolve => {
    const n = spawn('lark-cli', ['--profile', 'claude', 'im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', text],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errBuf = '';
    n.stderr.on('data', d => { errBuf += d; });
    n.on('close', code => {
      log(`飞书通知: ${code === 0 ? '已送达' : `失败 exit=${code} ${errBuf.slice(-200)}`}`);
      resolve();
    });
    n.on('error', err => { log(`飞书通知拉起失败: ${err.message}`); resolve(); });
  });
})().catch(err => {
  try { writeStatus({ state: 'error', error: String(err && err.message || err) }); } catch (_) {}
  log('执行器异常: ' + (err && err.stack || err));
  process.exit(1);
});

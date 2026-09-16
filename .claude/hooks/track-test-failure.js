// PostToolUse hook：修改 src/*.ts 後執行測試，失敗則累加計數，通過則歸零
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, '.claude', 'state');
const stateFile = path.join(stateDir, 'fix-attempts.count');

const readInput = () => new Promise((resolve) => {
  let data = '';
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});

(async () => {
  const raw = await readInput();
  let filePath = '';
  try {
    const input = JSON.parse(raw);
    filePath = input.tool_input && input.tool_input.file_path ? input.tool_input.file_path : '';
  } catch (e) {
    process.exit(0);
  }

  const normalized = filePath.replace(/\\/g, '/');
  if (!/^src\/.*\.(ts|tsx)$/.test(normalized) && !normalized.includes('/src/')) {
    process.exit(0);
  }

  fs.mkdirSync(stateDir, { recursive: true });
  if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, '0');

  try {
    execSync('npm test -- --run', { cwd: projectDir, stdio: 'pipe' });
    fs.writeFileSync(stateFile, '0');
    process.exit(0);
  } catch (err) {
    const current = parseInt(fs.readFileSync(stateFile, 'utf8').trim() || '0', 10);
    const next = current + 1;
    fs.writeFileSync(stateFile, String(next));
    process.stderr.write(`測試未通過，第 ${next} 次修補嘗試。\n`);
    process.stderr.write((err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : ''));
    process.exit(2);
  }
})();

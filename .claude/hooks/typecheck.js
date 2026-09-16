// PostToolUse hook：修改 .ts/.tsx 檔後執行型態檢查
const { execSync } = require('child_process');

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

  if (!/\.(ts|tsx)$/.test(filePath)) {
    process.exit(0);
  }

  try {
    execSync('npx tsc --noEmit', { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), stdio: 'pipe' });
    process.exit(0);
  } catch (err) {
    process.stderr.write((err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : ''));
    process.exit(2);
  }
})();

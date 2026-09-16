// PostToolUse hook：修改 src/*.ts 後執行測試，偵測「這次編輯是否讓原本會過的測試變成失敗」（退化），
// 只有出現不在基準清單內的新失敗項目時才累加熔斷計數器；既有的、與本次編輯無關的紅燈不計入。
const fs = require('fs');
const path = require('path');
const { runTestsAndGetFailures } = require('./lib/test-report.cjs');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const stateDir = path.join(projectDir, '.claude', 'state');
const stateFile = path.join(stateDir, 'fix-attempts.count');
const baselineFile = path.join(stateDir, 'baseline-failures.json');
const reportFile = path.join(stateDir, 'test-report.json');

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

  let failures;
  try {
    failures = runTestsAndGetFailures(projectDir, reportFile);
  } catch (err) {
    process.stderr.write(`測試報告產生或解析失敗，本次略過退化判定（不計入熔斷）：${err.message}\n`);
    process.exit(0);
  }

  if (!fs.existsSync(baselineFile)) {
    fs.writeFileSync(
      baselineFile,
      JSON.stringify({ updatedAt: new Date().toISOString(), failureIds: failures.map((f) => f.id) }, null, 2)
    );
    fs.writeFileSync(stateFile, '0');
    process.stderr.write(
      `尚無基準失敗清單，已依本次測試結果建立基準（共 ${failures.length} 項既有失敗），本次不計入熔斷判定。\n`
    );
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const baselineIds = new Set(baseline.failureIds || []);
  const newFailures = failures.filter((f) => !baselineIds.has(f.id));

  if (newFailures.length === 0) {
    fs.writeFileSync(stateFile, '0');
    process.exit(0);
  }

  const current = parseInt(fs.readFileSync(stateFile, 'utf8').trim() || '0', 10);
  const next = current + 1;
  fs.writeFileSync(stateFile, String(next));
  process.stderr.write(
    `偵測到退化：本次編輯讓 ${newFailures.length} 項原本不在基準清單內的測試失敗，第 ${next} 次修補嘗試。\n`
  );
  newFailures.forEach((f) => process.stderr.write(`  - ${f.label}\n`));
  process.exit(2);
})();
